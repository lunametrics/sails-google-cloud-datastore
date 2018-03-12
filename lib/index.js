/*
 * Sails.js/Waterline adapter for Google Cloud Datastore.
 */
/* global Promise */
const GoogleCloudDatastore = require('@google-cloud/datastore');
const _ = require('@sailshq/lodash');
const parseWhereClause = require('./helpers/parseWhereClause');
const entityToItem = require('./helpers/entityToItem');
const itemToEntity = require('./helpers/itemToEntity');
const registeredDsEntries = {};
const _models = {};

const adapter = {
  adapterApiVersion: 1,
  identity: 'sails-google-cloud-datastore',
  defaults: {
    schema: false
  },
  datastores: registeredDsEntries,
  registerDatastore: (dsConfig, models, done) => {

    const {
      identity,
      projectId
    } = dsConfig;

    if (!projectId) {
      let msg = 'Missing required configuration `projectId`';
      return done(new Error(msg));
    }

    // Create a manager
    registeredDsEntries[identity] = {
      config: dsConfig,
      manager: createManager({projectId}),
      sequences: {}
    };

    _.each(models, model => {

      _models[model.identity] = {
        primaryKey: model.primaryKey,
        attributes: model.definition,
        tableName: model.tableName,
        identity: model.identity,
      };

    });

    done();

  },
  teardown: (identity, done) => {

    delete registeredDsEntries[identity];

    done();

  },
  createManager: createManager,
  /**
   * @param {string} identity
   * @param {StageThreeQuery} s3q
   * @param {Function} done
   */
  createEach: (identity, s3q, done) => {

    const gcDatastoreInstance = registeredDsEntries[identity].manager;
    const tableName = s3q.using;
    const items = s3q.newRecords;
    const model = _.find(_models, {tableName});
    const mapArgs = { model, gcDatastoreInstance, tableName };
    const entities = items.map(item => itemToEntity(_.extend({item}, mapArgs)));

    checkUniqueKeys({identity, s3q, model, items})
      .then(badItems => {

        let err;

        if (badItems.length) {

          err = new Error(`${badItems.length} record(s) would violate uniqueness constraint-- record(s) already exists with conflicting value(s).`);

          err.code = 'E_UNIQUE';
          err.attrNames = badItems.reduce((names, badItem) => names.concat(badItem.attrNames), []);
          err.records = badItems;

          return done(err);

        }

        gcDatastoreInstance.save(entities.map(createSavableEntity))
          .then(() => {

            if (!s3q.meta.fetch) { return done(); }

            const items = entities.map(entity => entityToItem({entity, model}));

            done(null, items);

          }).catch(done);

      })
      .catch(done);


  },
  /**
   * Create a new record
   *
   * @param {string} identity
   * @param {StageThreeQuery} s3q
   * @param {Function} done
   */
  create: function (identity, s3q, done) {

    s3q.newRecords = [s3q.newRecord];

    this.createEach(identity, s3q, (err, items) => {

      if (err) { return done(err); }

      done(null, items[0]);

    });

  },
  /**
   * @param {string} identity
   * @param {StageThreeQuery} s3q
   * @param {Function} done
   */
  update: (identity, s3q, done) => {

    const gcDatastoreInstance = registeredDsEntries[identity].manager;
    const tableName = s3q.using;
    const model = _.find(_models, {tableName});
    const values = s3q.valuesToSet;

    getEntities(gcDatastoreInstance, s3q)
      .then(entities => {

        const updates = entities.map(entity => Object.assign({}, entity, values));

        return gcDatastoreInstance
          .update(updates)
          .then(() => {

            if (!s3q.meta.fetch) { return done(); }

            const items = updates.map(entity => entityToItem({entity, model}));

            done(null, items);

          });

      })
      .catch(done);

  },
  /**
   * Deletes an entity
   * @param {string} identity
   * @param {StageThreeQuery} s3q
   * @param {Function} done
   */
  destroy: (identity, s3q, done) => {

    const gcDatastoreInstance = registeredDsEntries[identity].manager;
    const KEY_SYMBOL = gcDatastoreInstance.KEY;

    getEntities(gcDatastoreInstance, s3q)
      .then(entities => {

        const entityKeys = entities.map(item => item[KEY_SYMBOL]);

        gcDatastoreInstance
          .delete(entityKeys)
          .then(() => done());

      })
      .catch(done);

  },
  /**
   * Currently doesn't support nin or like
   *
   * @param {string} identity
   * @param {StageThreeQuery} s3q
   * @param {Function} done
   */
  find: function (identity, s3q, done) {

    const gcDatastoreInstance = registeredDsEntries[identity].manager;
    const tableName = s3q.using;
    const model = _.find(_models, {tableName});

    getEntities(gcDatastoreInstance, s3q)
      .then(entities => {

        const items = entities.map(entity => {

          const item = entityToItem({entity, model});
          let key;

          if (s3q.criteria.select && s3q.criteria.select.join() !== '*') {
            for (key in item) {
              if (s3q.criteria.select.indexOf(key) === -1) { delete item[key]; }
            }
          }

          return item;

        });

        done(null, items);

      })
      .catch(done);

  },
  drop: (identity, using, unused, done) => {

    // Get all entities
    const gcDatastoreInstance = registeredDsEntries[identity].manager;

    recursiveDelete({gcDatastoreInstance, using, done});

  },
  // Not needed for GCDS
  define: (identity, using, model, done) => done(),
  // Currently unsuported:
  count: notImplemented('count'),
  sum: notImplemented('sum'),
  avg: notImplemented('avg'),
  setSequence: notImplemented('setSequence', 3),
};

/**
 * Stubs unsupported methods
 *
 * @param {String} methodName
 * @param {Number} doneArgNum
 *
 * @returns {Function}
 */
function notImplemented(methodName, doneArgNum) {

  doneArgNum = doneArgNum || 2;

  return function _notImplemented() {

    const done = arguments[doneArgNum];
    const err = new Error(`${methodName} not implemented.`);

    done(err);

  };

}

/**
 * @param {Datastore} gcDatastoreInstance
 * @param {Stage3Query} s3q
 *
 * @returns {Promise}
 */
function getEntities(gcDatastoreInstance, s3q) {

  const queries = buildQueries(gcDatastoreInstance, s3q);

  return new Promise((resolve, reject) => {

    Promise.all(queries.map(query => gcDatastoreInstance.runQuery(query)))
      .then(resps => {

        const results = resps.reduce((arr, resp) => arr.concat(resp[0]), []);

        resolve(results.filter(entity => {

          return !_.isUndefined(entity);

        }));

      })
      .catch(reject);

  });

}

/**
 * @param {GoogleCloudDatastore} gcDatastoreInstance
 * @param {Stage3Query} s3q
 *
 * @returns {GoogleCloudDatastore#Query[]}
 */
function buildQueries(gcDatastoreInstance, s3q) {

  const {
    criteria
  } = s3q;
  const hasCriteria = criteria.where && Object.keys(criteria.where).length > 0;
  const model = _.find(_models, {tableName: s3q.using});
  const primaryKey = model.primaryKey;
  const columnName = model.attributes[primaryKey].columnName;
  let queries;

  if (hasCriteria) {

    queries = parseWhereClause(criteria.where).map(filters => {

      const query = gcDatastoreInstance.createQuery(s3q.using);

      filters.forEach(filter => {

        if (filter[0] === columnName) {

          let key = gcDatastoreInstance.key([s3q.using, filter[1]]);
          query.filter('__key__', key);

        } else {

          query.filter.apply(query, filter);

        }

      });

      return query;

    });

  } else {

    queries = [gcDatastoreInstance.createQuery(s3q.using)];

  }

  if (criteria.limit && criteria.limit > 0) {

    queries.forEach(query => query.limit(Math.min(2147483647.0, criteria.limit)));

  }

  if (criteria.skip) {

    queries.forEach(query => query.offset(criteria.skip));

  }

  if (criteria.sort) {

    queries.forEach(query => {

      criteria.sort.forEach(sort => {

        const field = Object.keys(sort)[0];
        query.order(field, {
          descending: sort[field] !== 'ASC'
        });

      });

    });

  }

  return queries;

}

/**
 * @param {Object} config
 * @param {String} config.projectId
 *
 * @returns {GoogleCloudDatastore}
 */
function createManager(config) {

  const {
    projectId
  } = config;

  return new GoogleCloudDatastore({
    projectId: projectId,
  });

}

/**
 * @param {Entity} entity
 *
 * @returns {Object}
 */
function createSavableEntity(entity) {

  const clone = _.clone(entity);

  const KEY_SYMBOL = GoogleCloudDatastore.KEY;
  const key = entity[KEY_SYMBOL];

  return {
    key: key,
    data: clone
  };

}

/**
 * @param {object} config
 * @param {GoogleCloudDatastore} config.gcDatastoreInstance
 * @param {GoogleCloudDatastore#Query} config.keysOnlyQuery
 * @param {Function} config.done
 */
function recursiveDelete(config) {

  const {
    gcDatastoreInstance,
    using,
    done
  } = config;
  const keysOnlyQuery = config.keysOnlyQuery || gcDatastoreInstance.createQuery(using).select('__key__');
  const noMoreResults = gcDatastoreInstance.NO_MORE_RESULTS;
  const KEY_SYMBOL = gcDatastoreInstance.KEY;

  gcDatastoreInstance.runQuery(keysOnlyQuery)
    .then(resp => {

      const entities = resp[0];
      const info = resp[1];
      const keys = entities.map(entity => entity[KEY_SYMBOL]);

      gcDatastoreInstance
        .delete(keys)
        .then(() => {

          if (!entities.length || info.moreResults === noMoreResults) {
            return done();
          }

          keysOnlyQuery.start(info.endCursor);

          recursiveDelete({gcDatastoreInstance, keysOnlyQuery, done});

        });

    })
    .catch(done);

}


/**
 * Enforces field uniqueness
 *
 * @param {Object} config
 * @param {Object[]} config.items
 * @param {Object} config.model - waterline model
 * @param {Object} config.s3q
 * @param {GoogleCloudDatastore} config.gcDatastoreInstance
 *
 * @returns {Promise} - bad items
 */
function checkUniqueKeys(config) {

  const {
    model,
    items,
    s3q,
    identity
  } = config;
  const uniqueKeys = Object.keys(model.attributes)
    .filter(key => {
      const autoMig = model.attributes[key].autoMigrations;
      return autoMig && autoMig.unique;
    });

  return new Promise((resolve, reject) => {

    return Promise.all(uniqueKeys.map(key => checkUniqueKey({identity, s3q, key, items})))
      .then(results => {

        const badItems = results.reduce((arr, next) => arr.concat(next), []);

        resolve(badItems);

      })
      .catch(reject);

  });

}

/**
 * Enforces field uniqueness
 *
 * @param {Object} config
 * @param {Object} config.s3q
 * @param {Object[]} config.items
 * @param {Object} config.key
 * @param {GoogleCloudDatastore} config.gcDatastoreInstance
 *
 * @returns {Promise} - bad items
 */
function checkUniqueKey(config) {

  const {
    items,
    key,
    s3q,
    identity
  } = config;
  const vals = items.map(i => i[key]).filter(v => typeof v !== 'undefined');
  const s3qWhere = {
    or: vals.map(val => { const obj = {}; obj[key] = val; return obj; })
  };

  return new Promise((resolve, reject) => {

    if (!s3qWhere.or.length) { return resolve([]); }

    adapter.find(identity, {
      using: s3q.using,
      criteria: {
        where: s3qWhere,
        select: [ key ]
      }
    }, (err, items) => {

      if (err) { return reject(err); }

      const badItems = items.map(item => {

        const err = new Error('Would violate uniqueness constraint-- a record already exists with conflicting value(s).');

        err.code = 'E_UNIQUE';
        err.attrNames = [key];
        err.record = item;

        return err;

      });

      resolve(badItems);

    });

  });

}

module.exports = adapter;