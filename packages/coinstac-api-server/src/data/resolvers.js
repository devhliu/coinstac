const rethink = require('rethinkdb');
const Boom = require('boom');
const GraphQLJSON = require('graphql-type-json');
const Promise = require('bluebird');
const { PubSub, withFilter } = require('graphql-subscriptions');
const axios = require('axios');
const { uniq } = require('lodash');
const helperFunctions = require('../auth-helpers');
const initSubscriptions = require('./subscriptions');
const config = require('../../config/default');

/**
 * Helper function to retrieve all members of given table
 * @param {string} table - The table name
 * @return {array} The contents of the requested table
 */
function fetchAll(table) {
  let connection;
  return helperFunctions.getRethinkConnection()
    .then((db) => {
      connection = db;
      return rethink.table(table).orderBy({ index: 'id' }).run(connection);
    })
    .then(cursor => cursor.toArray())
    .then(res => connection.close().then(() => res));
}

/**
 * Helper function to retrieve a single entry in a table
 * @param {string} table - The table name
 * @param {string} id - The entry id
 * @return {object} The requested table entry
 */
function fetchOne(table, id) {
  return helperFunctions.getRethinkConnection()
    .then(connection => rethink.table(table).get(id).run(connection));
}

function fetchOnePipeline(id) {
  return helperFunctions.getRethinkConnection()
    .then(connection => rethink.table('pipelines')
      .get(id)
    // Populate computations subfield with computation meta information
      .merge(pipeline => ({
        steps: pipeline('steps').map(step => step.merge({
          computations: step('computations').map(compId => rethink.table('computations').get(compId)),
        })),
      }))
      .run(connection)
      .then(res => connection.close().then(() => res)))
    .then(result => result);
}

/**
 * Helper function for add permissions to an user
 * @param {object} connection - Existing db connection
 * @param {object} args - Update object
 * @param {string} args.userId - Id of the user which will have permissions changed
 * @param {string} args.role - Role of the user
 * @param {string} args.doc - Id of the document for which the user will gain access
 * @param {string} args.table - Table of the document for which the user will gain access
 */
async function addUserPermissions(connection, args) {
  const perms = await rethink.table('users').get(args.userId)('permissions').run(connection);

  const { role, doc, table } = args;

  let newRoles = [role];
  const promises = [];

  // Grab existing roles if present
  if (perms[table][doc] && perms[table][doc].indexOf(role) === -1) {
    newRoles = newRoles.concat(perms[table][doc]);
  } else if (perms[table][doc]) {
    newRoles = perms[table][doc];
  }

  const updateObj = { permissions: { [table]: { [doc]: newRoles } } };

  // Add entry to user statuses object &&
  if (table === 'consortia') {
    updateObj.consortiaStatuses = {};
    updateObj.consortiaStatuses[doc] = 'none';

    promises.push(
      rethink.table('consortia').get(doc).update(
        {
          [`${role}s`]: rethink.row(`${role}s`).append(args.userId),
        }
      ).run(connection)
    );
  }

  promises.push(
    rethink.table('users').get(args.userId).update(
      updateObj, { returnChanges: true }
    ).run(connection)
  );

  return Promise.all(promises);
}

async function removeUserPermissions(connection, args) {
  const promises = [];

  const nextPermissions = await rethink.table('users')
    .get(args.userId)('permissions')(args.table)(args.doc)
    .filter(role => role.ne(args.role))
    .run(connection);

  if (nextPermissions.length === 0) {
    const replaceObj = {
      permissions: { [args.table]: args.doc },
    };

    if (args.table === 'consortia') {
      replaceObj.consortiaStatuses = args.doc;

      await rethink.table('consortia')
        .get(args.doc)
        .update({ mappedForRun: rethink.row('mappedForRun').difference([args.userId]) })
        .run(connection);
    }

    promises.push(
      rethink.table('users').get(args.userId).replace(user => user.without(replaceObj), { nonAtomic: true }).run(connection)
    );
  } else {
    promises.push(
      rethink.table('users')
        .get(args.userId)
        .update({
          permissions: {
            [args.table]: {
              [args.doc]: rethink.row('permissions')(args.table)(args.doc).difference([args.role]),
            },
          },
        }, { nonAtomic: true })
        .run(connection)
    );
  }

  if (args.table === 'consortia') {
    promises.push(
      rethink.table('consortia').get(args.doc).update(
        {
          [`${args.role}s`]: rethink.row(`${args.role}s`).difference([args.userId]),
        }
      ).run(connection)
    );
  }

  await Promise.all(promises);
}

const pubsub = new PubSub();

initSubscriptions(pubsub);

/* eslint-disable */
const resolvers = {
  JSON: GraphQLJSON,
  Query: {
    /**
     * Returns all results.
     * @return {array} All results
     */
    fetchAllResults: () => fetchAll('runs'),
    /**
     * Returns single pipeline
     * @param {object} args
     * @param {string} args.resultId  Requested pipeline ID
     * @return {object} Requested pipeline if id present, null otherwise
     */
    fetchResult: (_, args) => {
      if (!args.resultId) {
        return null;
      } else {
        return helperFunctions.getRethinkConnection()
          .then(connection =>
            rethink.table('runs')
              .get(args.resultId)
              .run(connection).then(res => connection.close().then(() => res))
          )
          .then(result => result);
      }
    },
    /**
     * Fetches all public consortia and private consortia for which the current user has access
     * @return {array} All consortia to which the current user access
     */
    fetchAllConsortia: async ({ auth: { credentials } }) => {
      const connection = await helperFunctions.getRethinkConnection();

      const cursor = await rethink
        .table('consortia')
        .orderBy({ index: 'id' })
        .filter(rethink.row('isPrivate').eq(false).or(rethink.row('members').contains(credentials.id)))
        .run(connection);

      const results = await cursor.toArray();

      await connection.close();

      return results;
    },
    /**
     * Returns single consortium.
     * @param {object} args
     * @param {string} args.consortiumId Requested consortium ID
     * @return {object} Requested consortium if id present, null otherwise
     */
    fetchConsortium: (_, args) => args.consortiumId ? fetchOne('consortia', args.consortiumId) : null,
    /**
     * Returns all computations.
     * @return {array} All computations
     */
    fetchAllComputations: () => fetchAll('computations'),
    /**
     * Returns metadata for specific computation name
     * @param {object} args
     * @param {array} args.computationIds Requested computation ids
     * @return {array} List of computation objects
     */
    fetchComputation: (_, args) => {
      return helperFunctions.getRethinkConnection()
        .then((connection) =>
          rethink.table('computations').getAll(...args.computationIds)
            .run(connection).then(res => connection.close().then(() => res))
        )
        .then((cursor) => cursor.toArray())
        .then((result) => {
          return result;
        });
    },
    /**
     * Returns all pipelines.
     * @return {array} List of all pipelines
     */
    fetchAllPipelines: () => {
      return helperFunctions.getRethinkConnection()
        .then(connection =>
          rethink.table('pipelines')
            .orderBy({ index: 'id' })
            .map(pipeline =>
              pipeline.merge(pipeline =>
                ({
                  steps: pipeline('steps').map(step =>
                    step.merge({
                      computations: step('computations').map(compId =>
                        rethink.table('computations').get(compId)
                      )
                    })
                  )
                })
              )
            )
            .run(connection).then(res => connection.close().then(() => res))
        )
        .then(cursor => cursor.toArray())
        .then(result => result);
    },
    /**
     * Returns single pipeline
     * @param {object} args
     * @param {string} args.pipelineId  Requested pipeline ID
     * @return {object} Requested pipeline if id present, null otherwise
     */
    fetchPipeline: (_, args) => {
      if (!args.pipelineId) {
        return null;
      } else {
        return helperFunctions.getRethinkConnection()
          .then(connection =>
            rethink.table('pipelines')
              .get(args.pipelineId)
              // Populate computations subfield with computation meta information
              .merge(pipeline =>
                ({
                  steps: pipeline('steps').map(step =>
                    step.merge({
                      computations: step('computations').map(compId =>
                        rethink.table('computations').get(compId)
                      )
                    })
                  )
                })
              )
              .run(connection).then(res => connection.close().then(() => res))
          )
          .then(result => result);
      }
    },
    /**
     * Returns single user.
     * @param {object} args
     * @param {string} args.userId Requested user ID, restricted to authenticated user for time being
     * @return {object} Requested user if id present, null otherwise
     */
    fetchUser: ({ auth: { credentials } }, args) => {
      if (args.userId !== credentials.id) {
        return Boom.unauthorized('Unauthorized action');
      }

      return fetchOne('users', credentials.id);
    },
    fetchAllUsers: () => fetchAll('users'),
    fetchAllUserRuns: ({ auth: { credentials } }, args) => {
      let connection;
      return helperFunctions.getRethinkConnection()
        .then((db) => {
          connection = db;
          return rethink.table('runs')
            .orderBy({ index: 'id' })
            .filter(
              rethink.row('clients').contains(credentials.id).
              or(rethink.row('sharedUsers').contains(credentials.id))
            )
            .run(connection);
          }
        )
        .then(cursor => cursor.toArray())
        .then(res => connection.close().then(() => res));
    },
    fetchAllThreads: async ({ auth: { credentials } }) => {
      const connection = await helperFunctions.getRethinkConnection();
      const cursor = await rethink.table('threads')
        .filter(doc => {
          return doc('users').contains(user => {
            return user('username').eq(credentials.id)
          })
        })
        .run(connection)
      const threads = cursor.toArray()

      await connection.close()

      return threads
    },
    validateComputation: (_, args) => {
      return new Promise();
    },
  },
  Mutation: {
    /**
     * Add computation to RethinkDB
     * @param {object} args
     * @param {object} args.computationSchema Computation object to add/update
     * @return {object} New/updated computation object
     */
    addComputation: ({ auth: { credentials } }, args) => {
      return helperFunctions.getRethinkConnection()
        .then((connection) =>
          rethink.table('computations').insert(
            Object.assign({}, args.computationSchema, { submittedBy: credentials.id }),
            {
              conflict: "replace",
              returnChanges: true,
            }
          )
          .run(connection).then(res => connection.close().then(() => res))
        )
        .then((result) => {
          return result.changes[0].new_val;
        })
    },
    /**
     * Add new user role to user perms, currently consortia perms only
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.doc Id of the document to add role to
     * @param {string} args.role Role to add to perms
     * @param {string} args.userId Id of the user to be added
     * @return {object} Updated user object
     */
    addUserRole: async ({ auth: { credentials } }, args) => {
      const { permissions } = credentials

      const documentPermissions = permissions[args.table][args.doc];
      if (!documentPermissions || !documentPermissions.includes('owner')) {
        return Boom.forbidden('Action not permitted');
      }

      const connection = await helperFunctions.getRethinkConnection();
      await addUserPermissions(connection, args).then(res => connection.close().then(() => res));

      return helperFunctions.getUserDetails({ username: args.userId });
    },
    /**
     * Add run to RethinkDB
     * @param {String} consortiumId Run object to add/update
     * @return {object} New/updated run object
     */
    createRun: ({ auth }, { consortiumId }) => {
      if (!auth || !auth.credentials) {
        // No authorized user, reject
        return Boom.unauthorized('User not authenticated');
      }

      return fetchOne('consortia', consortiumId)
        .then(consortium => Promise.all([
          consortium,
          fetchOnePipeline(consortium.activePipelineId),
          helperFunctions.getRethinkConnection()
        ]))
        .then(([consortium, pipelineSnapshot, connection]) =>
          rethink.table('runs').insert(
            {
              clients: [...consortium.members],
              consortiumId,
              pipelineSnapshot,
              startDate: Date.now(),
              type: 'decentralized',
            },
            {
              conflict: "replace",
              returnChanges: true,
            }
          )
          .run(connection).then(res => connection.close().then(() => res))
        )
        .then((result) => {
          return axios.post(
            `http://${config.host}:${config.pipelineServer}/startPipeline`, { run: result.changes[0].new_val }
          ).then(() => {
              return result.changes[0].new_val;
          })
        })
        .catch(error => {
              console.log(error)
        });
    },
    /**
     * Deletes consortium
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.consortiumId Consortium id to delete
     * @return {object} Deleted consortium
     */
    deleteConsortiumById: ({ auth: { credentials: { permissions } } }, args) => {
      if (!permissions.consortia[args.consortiumId] || !permissions.consortia[args.consortiumId].includes('owner')) {
        return Boom.forbidden('Action not permitted');
      }

      return helperFunctions.getRethinkConnection()
        .then(connection =>
          new Promise.all([
            rethink.table('consortia').get(args.consortiumId)
              .delete({ returnChanges: true })
              .run(connection),
            rethink.table('users').replace(user =>
              user.without({
                permissions: { consortia: args.consortiumId },
                consortiaStatuses: args.consortiumId
              })
            ).run(connection),
            rethink.table('pipelines').filter({ owningConsortium: args.consortiumId })
              .delete()
              .run(connection)
          ]).then(res => connection.close().then(() => res))
        )
        .then(([consortium]) => consortium.changes[0].old_val)
    },
    /**
     * Deletes pipeline
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.pipelineId Pipeline id to delete
     * @return {object} Deleted pipeline
     */
    deletePipeline: async ({ auth: { credentials: { permissions } } }, args) => {
      const connection = await helperFunctions.getRethinkConnection()
      const pipeline = await rethink.table('pipelines')
        .get(args.pipelineId)
        .run(connection)

      if (!permissions.consortia[pipeline.owningConsortium] ||
          !permissions.consortia[pipeline.owningConsortium].includes('owner')
      ) {
        return Boom.forbidden('Action not permitted')
      }

      const runsCount = await rethink.table('runs')('pipelineSnapshot')
        .filter({ id: args.pipelineId })
        .count()
        .run(connection)

      if (runsCount > 0) {
        return Boom.badData('Runs on this pipeline exist')
      }

      await rethink.table('pipelines')
        .get(args.pipelineId)
        .delete({ returnChanges: true })
        .run(connection)

      await rethink.table('consortia')
        .filter({ activePipelineId: args.pipelineId })
        .replace(rethink.row.without('activePipelineId'))
        .run(connection)

      await connection.close()

      return pipeline
    },
    /**
     * Add logged user to consortium members list
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.consortiumId Consortium id to join
     * @return {object} Updated consortium
     */
    joinConsortium: async ({ auth: { credentials } }, args) => {
      const connection = await helperFunctions.getRethinkConnection()
      const consortium = await fetchOne('consortia', args.consortiumId)

      if (consortium.members.indexOf(credentials.id) !== -1) {
        return consortium
      }

      await addUserPermissions(connection, { userId: credentials.id, role: 'member', doc: args.consortiumId, table: 'consortia' })
      await connection.close()

      return fetchOne('consortia', args.consortiumId)
    },
    /**
     * Remove logged user from consortium members list
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.consortiumId Consortium id to join
     * @return {object} Updated consortium
     */
    leaveConsortium: async ({ auth: { credentials } }, args) => {
      const connection = await helperFunctions.getRethinkConnection();
      await removeUserPermissions(connection, { userId: credentials.id, role: 'member', doc: args.consortiumId, table: 'consortia' })
        .then(res => connection.close().then(() => res));

      return fetchOne('consortia', args.consortiumId);
    },
    /**
     * Deletes computation
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.computationId Computation id to delete
     * @return {object} Deleted computation
     */
    removeComputation: ({ auth: { credentials } }, args) => {
      return helperFunctions.getRethinkConnection()
        .then((connection) =>
          new Promise.all([
            connection,
            rethink.table('computations').get(args.computationId).run(connection)
          ])
        )
        .then(([connection, comp]) => {
          if (comp.submittedBy !== credentials.id) {
            return Boom.forbidden('Action not permitted');
          }

          return rethink.table('computations').get(args.computationId)
            .delete({ returnChanges: true }).run(connection).then(res => connection.close().then(() => res))
        })
        .then(result => result.changes[0].old_val)
    },
    /**
     * Add new user role to user perms, currently consortia perms only
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.userId Id of the user who will have permissions removed
     * @param {string} args.table Table of the document to add role to
     * @param {string} args.doc Id of the document to add role to
     * @param {string} args.role Role to add to perms
     * @param {string} args.userId Id of the user to be removed
     * @return {object} Updated user object
     */
    removeUserRole: async ({ auth: { credentials } }, args) => {
      const { permissions } = credentials

      if (!permissions[args.table][args.doc] || !permissions[args.table][args.doc].includes('owner')) {
        return Boom.forbidden('Action not permitted');
      }

      const connection = await helperFunctions.getRethinkConnection();
      await removeUserPermissions(connection, args)
        .then(res => connection.close().then(() => res));
      return helperFunctions.getUserDetails({ username: args.userId });
    },
    /**
     * Sets active pipeline on consortia object
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.consortiumId Consortium to update
     * @param {string} args.activePipelineId Pipeline ID to mark as active
     */
    saveActivePipeline: async ({ auth: { credentials } }, args) => {
      // const { permissions } = credentials;
      /* TODO: Add permissions
      if (!permissions.consortia.write
          && args.consortium.id
          && !permissions.consortia[args.consortium.id].write) {
            return Boom.forbidden('Action not permitted');
      }*/

      const connection = await helperFunctions.getRethinkConnection()
      const result = await rethink.table('consortia')
        .get(args.consortiumId)
        .update({ activePipelineId: args.activePipelineId, mappedForRun: [] })
        .run(connection)
      await connection.close()

      return result
    },
    /**
     * Saves consortium
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {object} args.consortium Consortium object to add/update
     * @return {object} New/updated consortium object
     */
    saveConsortium: async ({ auth: { credentials } }, args) => {
      const { permissions } = credentials;

      const isUpdate = !!args.consortium.id;

      if (isUpdate && !permissions.consortia[args.consortium.id].includes('owner')) {
        return Boom.forbidden('Action not permitted');
      }

      const connection = await helperFunctions.getRethinkConnection();

      if (!isUpdate) {
        const count = await rethink.table('consortia')
          .filter({ name: args.consortium.name })
          .count()
          .run(connection)

        if (count > 0) {
          return Boom.forbidden('Consortium with same name already exists');
        }
      }

      const result = await rethink.table('consortia')
        .insert(args.consortium, {
          conflict: 'update',
          returnChanges: true,
        })
        .run(connection);

      const consortiumId = args.consortium.id || result.changes[0].new_val.id;

      if (!isUpdate) {
        await addUserPermissions(connection, { userId: credentials.id, role: 'owner', doc: consortiumId, table: 'consortia' });
        await addUserPermissions(connection, { userId: credentials.id, role: 'member', doc: consortiumId, table: 'consortia' });
      }

      const consortium = await fetchOne('consortia', consortiumId);

      await connection.close();

      return consortium;
    },
    /**
     * Saves run error
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.runId Run id to update
     * @param {string} args.error Error
     */
    saveError: ({ auth: { credentials } }, args) => {
      const { permissions } = credentials;
      return helperFunctions.getRethinkConnection()
        .then((connection) =>
          rethink.table('runs').get(args.runId).update({ error: Object.assign({}, args.error), endDate: Date.now() })
          .run(connection).then(res => connection.close()));
          // .then(result => result.changes[0].new_val)
    },
    /**
     * Saves pipeline
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {object} args.pipeline Pipeline object to add/update
     * @return {object} New/updated pipeline object
     */
    savePipeline: async ({ auth: { credentials } }, args) => {
      // const { permissions } = credentials;
      /* TODO: Add permissions
      if (!permissions.consortia.write
          && args.consortium.id
          && !permissions.consortia[args.consortium.id].write) {
            return Boom.forbidden('Action not permitted');
      }*/
      const connection = await helperFunctions.getRethinkConnection();

      if (!args.pipeline.id) {
        const count = await rethink.table('pipelines')
          .filter({ name: args.pipeline.name })
          .count()
          .run(connection)

        if (count > 0) {
          return Boom.forbidden('Pipeline with same name already exists');
        }
      }

      if (args.pipeline && args.pipeline.steps) {
        const invalidData = args.pipeline.steps.some(step =>
          step.inputMap &&
          step.inputMap.covariates &&
          step.inputMap.covariates.ownerMappings &&
          step.inputMap.covariates.ownerMappings.some(variable =>
            !variable.type || !variable.source || !variable.name
          )
        );

        if (invalidData) {
          return Boom.badData('Some of the covariates are incomplete');
        }
      }

      const result = await rethink.table('pipelines')
        .insert(args.pipeline, {
          conflict: 'update',
          returnChanges: true,
        })
        .run(connection);

      const pipelineId = args.pipeline.id || result.changes[0].new_val.id;
      const pipeline = await fetchOnePipeline(pipelineId);

      await connection.close();

      return pipeline;
    },
    /**
     * Saves run results
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.runId Run id to update
     * @param {string} args.results Results
     */
    saveResults: ({ auth: { credentials } }, args) => {
      console.log("save results was called");
      const { permissions } = credentials;
      return helperFunctions.getRethinkConnection()
        .then((connection) =>
          rethink.table('runs').get(args.runId).update({ results: Object.assign({}, args.results), endDate: Date.now() })
          .run(connection).then(res => connection.close()))
          // .then(result => result.changes[0].new_val)
    },
    setActiveComputation: (_, args) => {
      return new Promise();
    },
    setComputationInputs: (_, args) => {
      return new Promise();
    },
    /**
     * Updates run remote state
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.runId Run id to update
     * @param {string} args.data State data
     */
    updateRunState: ({ auth: { credentials } }, args) => {
      const { permissions } = credentials;
      return helperFunctions.getRethinkConnection()
        .then((connection) => {
          return rethink.table('runs').get(args.runId).update({ remotePipelineState: args.data })
          .run(connection).then(res => connection.close());
        });
          // .then(result => result.changes[0].new_val)
    },
    /**
     * Saves consortium
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.consortiumId Consortium id to update
     * @param {string} args.status New status
     * @return {object} Updated user object
     */
    updateUserConsortiumStatus: ({ auth: { credentials } }, { consortiumId, status }) =>
      helperFunctions.getRethinkConnection()
        .then(connection =>
          rethink.table('users')
          .get(credentials.id).update({
            consortiaStatuses: {
              [consortiumId]: status,
            },
          }).run(connection).then(res => connection.close().then(() => res))
        )
        .then(result =>
          helperFunctions.getUserDetails({ username: credentials.id })
        )
        .then(result => result)
    ,
    /**
     * Updated consortium mapped users
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.consortiumId Consortium id to update
     * @param {string} args.mappedForRun New mappedUsers
     * @return {object} Updated consortia
     */
    updateConsortiumMappedUsers: async ({ auth: { credentials } }, args) => {
      const connection = await helperFunctions.getRethinkConnection()
      const result = await rethink.table('consortia')
        .get(args.consortiumId)
        .update({ mappedForRun: args.mappedForRun })
        .run(connection)
      await connection.close()
      return result
    },
    /**
     * Updated consortia mapped users
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.consortia Mapped consortiums
     * @return {object} Updated consortia
     */
    updateConsortiaMappedUsers: async ({ auth: { credentials } }, args) => {
      const connection = await helperFunctions.getRethinkConnection()
      const result = await rethink.table('consortia')
        .getAll(...args.consortia)
        .filter(rethink.row('mappedForRun').contains(credentials.id))
        .update({ mappedForRun: rethink.row('mappedForRun').difference([credentials.id]) })
        .run(connection)

      return result
    },
    /**
     * Save message
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.threadId Thread Id
     * @param {string} args.title Thread title
     * @param {array} args.recipients Message recipients
     * @param {array} args.content Message content
     * @param {object} args.action Message action
     * @return {object} Updated message
     */
    saveMessage: async ({ auth: { credentials } }, args) => {
      const { threadId, title, recipients, content, action } = args

      const connection = await helperFunctions.getRethinkConnection()

      const messageToSave = Object.assign(
        {
          id: rethink.uuid(),
          sender: credentials.id,
          recipients,
          content,
          date: Date.now(),
        },
        action && { action },
      )

      let result

      if (threadId) {
        const thread = await fetchOne('threads', threadId)
        const { messages, users } = thread
        const threadToSave = {
          messages: [...messages, messageToSave],
          users: uniq([...users.map(user => user.username), ...recipients])
            .map(user => ({ username: user, isRead: user === credentials.id })),
          date: Date.now(),
        }

        await rethink.table('threads')
          .get(threadId)
          .update(threadToSave, { nonAtomic: true })
          .run(connection)

        result = await fetchOne('threads', threadId)
      } else {
        const thread = {
          id: rethink.uuid(),
          owner: credentials.id,
          title: title,
          messages: [messageToSave],
          users: uniq([credentials.id, ...recipients])
            .map(user => ({ username: user, isRead: user === credentials.id })),
          date: Date.now(),
        }

        const res = await rethink.table('threads')
          .insert(thread, { returnChanges: true })
          .run(connection)

        result = res.changes[0].new_val
      }

      if (action && action.type === 'share-result') {
        const run = await fetchOne('runs', action.detail.id)
        const runToSave = {
          sharedUsers: uniq([...run.sharedUsers || [], ...recipients]),
        }

        await rethink.table('runs')
          .get(action.detail.id)
          .update(runToSave, { nonAtomic: true })
          .run(connection)
      }

      await connection.close()

      return result
    },
    /**
     * Set read mesasge
     * @param {object} auth User object from JWT middleware validateFunc
     * @param {object} args
     * @param {string} args.threadId Thread Id
     * @param {string} args.userId User Id
     * @return {object} None
     */
    setReadMessage: async ({ auth: { credentials } }, args) => {
      const { threadId, userId } = args

      const connection = await helperFunctions.getRethinkConnection()
      const thread = await fetchOne('threads', threadId)

      const threadToSave = {
        ...thread,
        users: thread.users.map(user => user.username === userId ? { ...user, isRead: true } : user)
      }

      await rethink.table('threads')
        .get(threadId)
        .update(threadToSave, { nonAtomic: true })
        .run(connection)

      await connection.close()

      return
    }
  },
  Subscription: {
    /**
     * Computation subscription
     * @param {object} payload
     * @param {string} payload.computationId The computation changed
     * @param {object} variables
     * @param {string} variables.computationId The computation listened for
     */
    computationChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator('computationChanged'),
        (payload, variables) => (!variables.computationId || payload.computationId === variables.computationId)
      )
    },
    /**
     * Consortium subscription
     * @param {object} payload
     * @param {string} payload.consortiumId The consortium changed
     * @param {object} variables
     * @param {string} variables.consortiumId The consortium listened for
     */
    consortiumChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator('consortiumChanged'),
        (payload, variables) => (!variables.consortiumId || payload.consortiumId === variables.consortiumId)
      )
    },
    /**
     * Pipeline subscription
     * @param {object} payload
     * @param {string} payload.pipelineId The pipeline changed
     * @param {object} variables
     * @param {string} variables.pipelineId The pipeline listened for
     */
    pipelineChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator('pipelineChanged'),
        (payload, variables) => (!variables.pipelineId || payload.pipelineId === variables.pipelineId)
      )
    },
    /**
     * Thread subscription
     * @param {object} payload
     * @param {string} payload.threadId The thread changed
     * @param {object} variables
     * @param {string} variables.threadId The thread listened for
     */
    threadChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator('threadChanged'),
        (payload, variables) => (!variables.threadId || payload.threadId === variables.threadId)
      )
    },
    /**
     * User subscription
     * @param {object} payload
     * @param {string} payload.userId The user changed
     * @param {object} variables
     * @param {string} variables.userId The user listened for
     */
    userChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator('userChanged'),
        (payload, variables) => (variables.userId || payload.userId === variables.userId)
      )
    },
    /**
     * User Metadata subscription
     * @param {object} payload
     * @param {string} payload.userId The user changed
     * @param {object} variables
     * @param {string} variables.userId The user listened for
     */
    userMetadataChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator('userMetadataChanged'),
        (payload, variables) => (variables.userId && payload.userId === variables.userId)
      )
    },
    /**
     * Run subscription
     * @param {object} payload
     * @param {string} payload.runId The run changed
     * @param {object} variables
     * @param {string} variables.userId The user listened for
     */
    userRunChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterator('userRunChanged'),
        (payload, variables) => (variables.userId && payload.userRunChanged.clients.indexOf(variables.userId) > -1)
      )
    },
  },
};

module.exports = {
  resolvers,
  pubsub,
};
