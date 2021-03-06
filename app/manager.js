const _       = require('lodash');
const path    = require('path');
const Promise = require('bluebird');

const Job    = require('./job');
const config = require('../config');
const log    = config.log;


const BACKLOG_QUEUE_KEY = 'backlog_queue';
const BACKLOG_HSET_KEY  = 'backlog_hset';
const COMPLETED_KEY     = 'completed';

let indexFilter     = null;
let indexComparator = null;
let typeFilter      = null;

let source = null;
let redis  = null;

/**
 * Manager constructor
 *
 * The manager prepares and 'manages' the jobs
 * @param sourceEs
 * @param redisClient
 * @constructor
 */
const Manager = function (sourceEs, redisClient) {
  const self = this;

  self.source = sourceEs;
  source      = sourceEs;
  redis       = redisClient;

  self.setIndexFilter     = setIndexFilter;
  self.setIndexComparator = setIndexComparator;
  self.setTypeFilter      = setTypeFilter;
  self.getFilterFunction  = getFilterFunction;

  self.getIndices            = getIndices;
  self.filterIndicesAndTypes = filterIndicesAndTypes;

  self.fetchJob    = fetchJob;
  self.queueJob    = queueJob;
  self.completeJob = completeJob;

  self.getCompletedJobs  = getCompletedJobs;
  self.getCompletedCount = getCompletedCount;
  self.getBacklogJobs    = getBacklogJobs;
  self.getBacklogCount   = getBacklogCount;

  self.clearBacklogJobs   = clearBacklogJobs;
  self.clearCompletedJobs = clearCompletedJobs;

  self.prepareNewJobs = prepareNewJobs;
  self.initialize     = initialize;

  self._addCountToJobs             = addCountToJobs;
  self._resetFiltersAndComparators = ()=> {
    indexFilter     = null;
    indexComparator = null;
    typeFilter      = null;
  };
};

/**
 * Pop a job off the queue and return it
 *
 * @returns {Promise.<TResult>}
 */
const fetchJob = ()=> {
  return redis.lpop(BACKLOG_QUEUE_KEY).then((jobID)=> {
    if (_.isNull(jobID)) {
      return null;
    }

    return redis.hget(BACKLOG_HSET_KEY, jobID).then((count)=> {
      return Job.createFromID(jobID, count);
    }).then((job)=> {
      return redis.hdel(BACKLOG_HSET_KEY, job.getID()).return(job);
    });
  });
};

/**
 * Add job to queue
 *
 * @param job
 * @returns {Promise.<TResult>}
 */
const queueJob = (job)=> {
  if (!(job instanceof Job)) {
    job = new Job(job);
  }

  return redis.hset(BACKLOG_HSET_KEY, job.getID(), job.count).then((numberAdded)=> {
    if (numberAdded === 0) {
      log.warn(`job: ${job} already in queue`);
      return Promise.resolve();
    } else {
      return redis.rpush(BACKLOG_QUEUE_KEY, job.getID());
    }
  });
};

/**
 * Mark a job as completed
 *
 * @param job
 * @returns {Promise.<TResult>}
 */
const completeJob = (job)=> {
  if (!(job instanceof Job)) {
    job = new Job(job);
  }

  return redis.hset(COMPLETED_KEY, job.getID(), job.count);
};

/**
 * Clear backlog
 *
 * @returns {Promise.<TResult>}
 */
const clearBacklogJobs = ()=> {
  log.info('clearing existing backlog');

  return redis.del(BACKLOG_QUEUE_KEY).then(()=> {
    return redis.del(BACKLOG_HSET_KEY);
  });
};

/**
 * Returns all backlog jobs and their counts
 *
 * @returns {Promise.<TResult>}
 */
const getBacklogJobs = ()=> {
  return redis.hgetall(BACKLOG_HSET_KEY).then((jobsAndCounts)=> {
    // ioredis returns an object where the keys are the hash fields and the values are the hash values
    return _.map(jobsAndCounts, (count, jobID)=> {
      return Job.createFromID(jobID, count);
    });
  });
};

/**
 * Get total docs in backlog
 *
 * @returns {Promise.<TResult>}
 */
const getBacklogCount = ()=> {
  return redis.hvals(BACKLOG_HSET_KEY).then((counts)=> {
    return _.reduce(counts, (total, count)=> {
      total += parseInt(count);
      return total;
    }, 0);
  });
};

/**
 * Returns all completed jobs and their counts
 *
 * @returns {Promise.<TResult>}
 */
const getCompletedJobs = ()=> {
  return redis.hgetall(COMPLETED_KEY).then((jobsAndCounts)=> {
    // ioredis returns an object where the keys are the hash fields and the values are the hash values
    return _.map(jobsAndCounts, (count, jobID)=> {
      return Job.createFromID(jobID, count);
    });
  });
};

/**
 * Get total docs completed
 *
 * @returns {Promise.<TResult>}
 */
const getCompletedCount = ()=> {
  return redis.hvals(COMPLETED_KEY).then((counts)=> {
    return _.reduce(counts, (total, count)=> {
      total += parseInt(count);
      return total;
    }, 0);
  });
};

/**
 * Clear any completed jobs
 *
 * @returns {Promise.<TResult>}
 */
const clearCompletedJobs = ()=> {
  return redis.del(COMPLETED_KEY);
};

/**
 * Use job definitions to count total docs
 *
 * @param jobs
 * @returns {*}
 */
const addCountToJobs = (jobs)=> {
  log.info('counting docs in existing indices');

  return Promise.mapSeries(jobs, (job)=> {
    return source.count({
      index: job.index,
      type:  job.type
    }).then((result)=> {
      job.count = parseInt(result.count);
      return job;
    });
  });
};

/**
 * Prepare backlog for use, removing completed jobs
 *
 * @param indexNames
 };
 * @param ignoreCompleted
 * @returns {Promise.<TResult>}
 */
const initialize = (indexNames, ignoreCompleted)=> {
  log.info('initializing job backlog..');
  return clearBacklogJobs().then(()=> {
    return prepareNewJobs(indexNames);
  }).then((potentialJobs)=> {
    if (ignoreCompleted) {
      return clearCompletedJobs().then(()=> {
        return potentialJobs;
      });
    } else {
      return getCompletedJobs().then((completed)=> {
        const completedJobs = _.map(completed, JSON.parse);

        return _.filter(potentialJobs, (potentialJob)=> {
          return !_.find(completedJobs, {index: potentialJob.index});
        });
      });
    }
  }).then(addCountToJobs).then((jobs)=> {
    log.info('Adding jobs to queue');
    return Promise.each(jobs, queueJob);
  });
};

/**
 * Based on the multi-index names provided, prepare the new jobs
 *
 * @param indexNames
 * @returns {Promise.<TResult>}
 */
const prepareNewJobs = (indexNames)=> {
  log.info('preparing new jobs');
  return getIndices(source, indexNames).then(filterIndicesAndTypes).then((filteredTargets)=> {
    if (_.isFunction(indexComparator)) {
      return filteredTargets.sort((a, b)=> {
        return indexComparator(a.index, b.index);
      });
    } else {
      return filteredTargets;
    }
  }).then((sortedTarget)=> {
    // The code below converts objects that looks like this:
    // {
    //  index: 'index_name',
    //    types: [
    //      'type1',
    //      'type2'
    //    ]
    // }
    //
    // Into an array of objects that look like this:
    // {
    //  index: 'index_name',
    //  type:  'type1'
    // },
    // {
    //  index: 'index_name',
    //  type:  'type2'
    // }
    //
    // Which is the final job format we want.
    return _.reduce(sortedTarget, (result, target)=> {
      _.map(target.types, (type)=> {
        result.push({
          index: target.index,
          type:  type
        });
      });

      return result;
    }, []);
  });
};

/**
 * Filter indices and types based on provided filters
 *
 * @param allIndices
 * @returns {Array}
 */
const filterIndicesAndTypes = (allIndices)=> {
  let selectedIndices = null;

  if (_.isFunction(indexFilter)) {
    selectedIndices = _.filter(allIndices, indexFilter);
  } else {
    selectedIndices = allIndices;
  }

  return _.reduce(selectedIndices, (result, index)=> {
    let selectedTypes = null;
    const allTypes    = _.reduce(index.mappings, (inner_result, type, name)=> {
      type.name = name;
      inner_result.push(type);

      return inner_result;
    }, []);

    if (_.isFunction(typeFilter)) {
      selectedTypes = _.filter(allTypes, typeFilter);
    } else {
      selectedTypes = allTypes;
    }

    const typeNames = _.map(selectedTypes, 'name');

    if (typeNames.length > 0) {
      result.push({
        index: index.name,
        types: typeNames
      });
    }

    return result;
  }, []);
};

/**
 * Set a regex or function to select the indices that will be transferred.
 *
 * @param filter
 */
const setIndexFilter = (filter)=> {
  indexFilter = getFilterFunction(filter);
  log.info('set index filter: ', filter);
};

/**
 * Set the comparator for sorting the indices in the order by which they are to be processed.
 *
 * @param comparator
 */
const setIndexComparator = (comparator)=> {
  if (_.isString(comparator)) {
    comparator = require(comparator);
  }

  if (!_.isFunction(comparator) || comparator.length !== 2) {
    throw new Error('comparator must be a function that takes 2 arguments');
  }

  indexComparator = comparator;
  log.info('set comparator');
};

/**
 * Set a regex or function to select the types from every index that will be transferred.
 *
 * @param filter
 */
const setTypeFilter = (filter)=> {
  typeFilter = getFilterFunction(filter);
  log.info('set type filter: ', filter);
};

/**
 * Returns an array of the indices found using the elasticsearch multi-index definition.
 *
 * The format is similar to an ES index GET command, but with the name nested in the element.
 *
 * @param client
 * @param targetIndices
 * @returns {Promise.<TResult>}
 */
const getIndices = (client, targetIndices) => {
  return client.indices.get({
    index:          targetIndices,
    allowNoIndices: true
  }).then((response)=> {
    return _.reduce(response, (result, index, name)=> {
      index.name = name;
      result.push(index);

      return result;
    }, []);
  });
};

/**
 * Take regex, string path, or function, and return function that returns a boolean
 *
 * @param filter
 */
const getFilterFunction = (filter)=> {
  let filterFunction = null;

  if (_.isString(filter)) {
    const extension = path.extname(filter);

    if (extension.length > 1) {
      if (extension !== '.js') {
        throw new Error(`filter: '${filter}' was interpreted as a path to a non-js file. Must be a path to a module, regex or function`);
      }

      try {
        filterFunction = require(filter);
        log.info(`Loaded filter: '${filter}' as module`);
      } catch (ex) {
        throw new Error(`filter: '${filter}' was interpreted as a path and cannot be found. Must be a path to a module, regex or function`);
      }

      if (!_.isFunction(filterFunction)) {
        throw new Error(`filter: '${filter}' was interpreted as a path and module does not return a function. Must be a path to a module, regex or function`);
      }

    } else {
      const regex = new RegExp(filter);

      filterFunction = (target)=> {
        log.info('target', target);
        return regex.test(target.name);
      };
      log.info(`Loaded filter: '${filter}' as regex`);
    }
  } else if (_.isRegExp(filter)) {
    filterFunction = (target)=> {
      return filter.test(target.name);
    };
    log.info(`Loaded filter: '${filter}' as regex`);
  } else if (_.isFunction(filter)) {
    filterFunction = filter;
    log.info(`Loaded filter: '${filter}' as function`);
  } else {
    throw new Error(`filter: '${filter}' could not be interpreted. Must be a path to a module, regex or function`);
  }

  if (filterFunction.length < 1) {
    throw new Error('filter function must take at least one argument');
  }

  return filterFunction;
};

module.exports = Manager;