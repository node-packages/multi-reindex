import cluster from 'cluster';
import _ from 'lodash';
import moment from 'moment';
import ProgressBar from 'progress';

import Job from './job';
import createEsClient from '../config/elasticsearch.js'
import redis from '../config/redis';
import config from '../config';
var log = config.log;

import Transfer from './transfer';
import Promise from 'bluebird';

var DATE_FORMAT = 'YYYY-MM-DD';
var DATE_REGEX  = /[0-9]{4}-[0-9]{2}-[0-9]{2}/;

var BACKLOG_QUEUE_KEY = 'backlog_queue';
var BACKLOG_HSET_KEY  = 'backlog_hset';
var COMPLETED_KEY     = 'completed';

var indexFilter     = null;
var indexComparator = null;
var typeFilter      = null;

var source     = null;
var totalCount = 0;

/**
 * Manager constructor
 *
 * The manager prepares and 'manages' the jobs
 *
 * @param sourceEs
 * @constructor
 */
var Manager = function (sourceEs) {
  var self = this;

  self.source = sourceEs;
  source      = sourceEs;

  self.setIndexFilter     = setIndexFilter;
  self.setIndexComparator = setIndexComparator;
  self.setTypeFilter      = setTypeFilter;

  self.getIndices            = getIndices;
  self.filterIndicesAndTypes = filterIndicesAndTypes;

  self.fetchJob    = fetchJob;
  self.queueJob    = queueJob;
  self.completeJob = completeJob;

  self.getCompletedJobs  = getCompletedJobs;
  self.getCompletedCount = getCompletedCount;
  self.getBacklogJobs    = getBacklogJobs;
  self.getBacklogCount   = getBacklogCount;
  self.getTotalCount     = ()=> { return totalCount; };


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
var fetchJob = ()=> {
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
var queueJob = (job)=> {
  if (!job) {
    throw new Error('job must be provided');
  }

  if (!(job instanceof Job)) {
    job = new Job(job);
  }

  return redis.hset(BACKLOG_HSET_KEY, job.getID(), job.count).then((numberAdded)=> {
    if (numberAdded === 0) {
      log.warn('job: ' + job.toString() + ' already in queue');
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
var completeJob = (job)=> {
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
var clearBacklogJobs = ()=> {
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
var getBacklogJobs = ()=> {
  return redis.hgetall(BACKLOG_HSET_KEY).then((jobsAndCounts)=> {
    // ioredis returns an object where the keys are the hash fields and the values are the hash values
    var jobs = _.map(jobsAndCounts, (count, jobID)=> {
      return Job.createFromID(jobID, count);
    });

    return jobs || [];
  });
};

/**
 * Get total docs in backlog
 *
 * @returns {Promise.<TResult>}
 */
var getBacklogCount = ()=> {
  return redis.hvals(BACKLOG_HSET_KEY).then((counts)=> {
    if (_.isNull(counts)) {
      return 0;
    }

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
var getCompletedJobs = ()=> {
  return redis.hgetall(COMPLETED_KEY).then((jobsAndCounts)=> {
    // ioredis returns an object where the keys are the hash fields and the values are the hash values
    var jobs = _.map(jobsAndCounts, (count, jobID)=> {
      return Job.createFromID(jobID, count);
    });

    return jobs || [];
  });
};

/**
 * Get total docs completed
 *
 * @returns {Promise.<TResult>}
 */
var getCompletedCount = ()=> {
  return redis.hvals(COMPLETED_KEY).then((counts)=> {
    if (_.isNull(counts)) {
      return 0;
    }

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
var clearCompletedJobs = ()=> {
  return redis.del(COMPLETED_KEY);
};

var _picked = (input)=> {
  return _.reduce(input, (result, value, key)=> {
    result.push(_.pick(input, key));
    return result;
  }, []);
};

var updateJobStatus = (job)=> {

};

/**
 * Use job definitions to count total docs
 *
 * @param jobs
 * @returns {*}
 */
var addCountToJobs = (jobs)=> {
  log.info('counting docs in existing indices');

  return Promise.mapSeries(jobs, (job)=> {
    return source.count({
      index: job.index,
      type:  job.type
    }).then((result)=> {
      job.count = parseInt(result.count);
      totalCount += job.count;
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
var initialize = (indexNames, ignoreCompleted)=> {
  return clearBacklogJobs().then(()=> {
    return prepareNewJobs(indexNames);
  }).then((potentialJobs)=> {
    if (ignoreCompleted) {
      return clearCompletedJobs().then(()=> { return potentialJobs; });
    } else {
      return getCompletedJobs().then((completed)=> {
        if (completed === null) {
          return potentialJobs;
        }

        let completedJobs = _.map(completed, JSON.parse);

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
var prepareNewJobs = (indexNames)=> {
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
var filterIndicesAndTypes = (allIndices)=> {
  let selectedIndices = null;

  // First filter out any unwanted indices
  if (_.isRegExp(indexFilter)) {
    selectedIndices = _.filter(allIndices, (index)=> { return indexFilter.test(index.name); })
  } else if (_.isFunction(indexFilter)) {
    selectedIndices = _.filter(allIndices, indexFilter);
  } else {
    selectedIndices = allIndices;
  }

  // Then filter out unwanted types in those indices
  return _.reduce(selectedIndices, (result, index)=> {
    let selectedTypes = null;
    let allTypes      = _.reduce(index.mappings, (result, type, name)=> {
      type.name = name;
      result.push(type);

      return result;
    }, []);

    if (_.isRegExp(typeFilter)) {
      selectedTypes = _.filter(allTypes, (type)=> { return typeFilter.test(type.name); })
    } else if (_.isFunction(typeFilter)) {
      selectedTypes = _.filter(allTypes, typeFilter);
    } else {
      selectedTypes = allTypes;
    }

    let typeNames = _.map(selectedTypes, 'name');

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
var setIndexFilter = (filter)=> {
  if (_.isRegExp(filter)) {
    indexFilter = filter;
  } else if (_.isFunction(filter) && filter.length === 1) {
    indexFilter = filter;
  } else {
    throw new Error('filter must be a regex or function that takes 1 argument');
  }
};

/**
 * Set the comparator for sorting the indices in the order by which they are to be processed.
 *
 * @param comparator
 */
var setIndexComparator = (comparator)=> {
  if (!_.isFunction(comparator) || comparator.length !== 2) {
    throw new Error('comparator must be a function that takes 2 arguments');
  }

  indexComparator = comparator;
};

/**
 * Set a regex or function to select the types from every index that will be transferred.
 *
 * @param filter
 */
var setTypeFilter = (filter)=> {
  if (_.isRegExp(filter)) {
    typeFilter = filter;
  } else if (_.isFunction(filter) && filter.length === 1) {
    typeFilter = filter;
  } else {
    throw new Error('filter must be a regex or function that takes 1 argument');
  }
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
var getIndices = (client, targetIndices) => {
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

export default Manager;