var GitHubApi = require('github');
var github = new GitHubApi({
  version: '3.0.0',
  debug: false
});

var Travis = require('travis-ci');
var travis = new Travis({ version: '2.0.0', debug: true });
var Q = require('q');
var $url = require('url');
var EventEmitter = require('events').EventEmitter;
var utils = require('util');
var childProcess = require('child_process');


/*
travis.builds({ repository_id: 136228 }, function(err, res) {
  console.log(err);
  console.log(res);
});
*/

/*
travis.repos({ owner_name: 'mozilla-b2g', name: 'gaia' }, function(err, res) {
  console.log(err);
  console.log(res);
});
*/

/**
 * Given a github pull request, find the Travis URL for the build, if any, and
 * return its link info on success or null on failure.
 *
 * Note that although the pull request explicitly includes a statuses_url, we
 * normalize this to commit info and then use the logic to try and get a status
 * from a commit hash.  This is partially for reuse but mainly because I don't
 * know how to make the github API just do a simple request lookup on that URL
 * directly.
 *
 * @param pullRequestInfo.user
 * @param pullRequestInfo.repo
 * @param pullRequestInfo.number
 */
function getGithubPullRequestTravisLink(pullRequestInfo) {
  var msg = {
    user: pullRequestInfo.user,
    repo: pullRequestInfo.repo,
    number: pullRequestInfo.number
  };
  return Q.nfcall(github.pullRequests.get, msg).then(function(res) {
    if (!res) {
      return null;
    }

    // the status info actually comes from the repo the pull request lives in,
    // not the repo originating the pull request
    var commitInfo = {
      user: pullRequestInfo.user,
      repo: pullRequestInfo.repo,
      sha: res.head.sha
    };
    return getGithubCommitTravisLink(commitInfo);
  });
}

function getGithubCommitTravisLink(commitInfo) {
  var msg = {
    user: commitInfo.user,
    repo: commitInfo.repo,
    sha: commitInfo.sha
  };
  return Q.nfcall(github.statuses.get, msg).then(function(res) {
    if (!res.length) {
      return null;
    }
    var status = res.pop();
    var url = status.target_url;
    var linkInfo = analyzeLink(url);
    if (linkInfo.type === 'unknown') {
      linkInfo = null;
    }
    return linkInfo;
  });
}

/**
 * Translate a github user/repo to a Travis Repository ID.
 */
function getTravisRepositoryId(user, repo, callback) {
  var query = { owner_name: user };
  if (repo) {
    query.name = repo;
  }
  return Q.nfcall(travis.repos, query).then(function(res) {
    if (!res.repo) {
    }
  });
}

/**
 * Retrieve the travis build status and normalize it.
 */
function getTravisBuildStatus(buildInfo) {
  //console.log('retrieving travis build info for', buildInfo.id);
  return Q.nfcall(travis.builds, { id: buildInfo.id }).then(function(res) {
    //console.log('travis results:', res);
    var build = res;
    var state = {
      state: res.build.state,
      jobs: res.jobs.map(function(job) {
        var env = job.config.env;
        var ciActionMatch = /CI_ACTION=([^ ]+)/.exec(env);
        var useName;
        if (ciActionMatch) {
          useName = ciActionMatch[1];
        }
        else {
          useName = job.number;
        }
        return {
          name: useName,
          state: job.state
        };
      })
    };
    return state;
  });
}

/**
 * Given a link URL, figure out what type of starting clue we've got.
 *
 * Valid types are:
 * - pull-request: We're being pointed at a github pull request, so we either
 *   need to watch the pull-request for a travis link to show up or we need to
 *   watch the list of travis pull requests for it to show up there.
 *
 * - travis-build: We already know exactly what build to watch!  Score!
 *
 * There are other things we could handle, but that's future work.
 */
function analyzeLink(urlStr) {
  var url = $url.parse(urlStr);

  var domain = url.hostname;
  var pathParts = url.pathname.split('/');
  // lose the empty string from the part.  harmless if already empty
  pathParts.shift();

  var githubUser, githubRepo, pullRequestNum, buildId;

  if (domain === 'github.com' && pathParts.length >= 2) {
    githubUser = pathParts[0];
    githubRepo = pathParts[1];

    if (pathParts.length >= 4 && pathParts[2] === 'pull') {
      pullRequestNum = parseInt(pathParts[3], 10);

      return {
        type: 'pull-request',
        user: githubUser,
        repo: githubRepo,
        number: pullRequestNum
      };
    }
  }
  else if (domain === 'travis-ci.org' && pathParts.length >= 3) {
    githubUser = pathParts[0];
    githubRepo = pathParts[1];

    buildId = parseInt(pathParts[3], 10);

    return {
      type: 'travis-build',
      user: githubUser,
      repo: githubRepo,
      id: buildId
    };
  }

  return {
    type: 'unknown',
    err: 'unsupported-url',
    errArgs: urlStr
  };
}

function PollingProber(state, details) {
  this.events = new EventEmitter();

  this._bound_poll = this.poll.bind(this);

  this.state = state;
  this.githubInfo = details.githubInfo || null;
  this.buildInfo = details.buildInfo || null;
  this.buildState = details.buildState || null;

  this.costSoFar = 0;

  this.timer = null;
}
PollingProber.prototype = {
  POLL_INTERVAL_MS: 60 * 1000,

  MAX_COST: 120,

  setNewBuildState: function(state) {
    // XXX perform state / transition diffing
    this.buildState = state;

    this.events.emit('stateUpdate', state);
  },

  /**
   * Poll the server immediately.  When the request gets resolved,
   */
  poll: function() {
    console.log('polling', this.state, 'current cost:', this.costSoFar);
    if (this.costSoFar++ > this.MAX_COST) {
      console.error('Giving up, current cost is:', this.costSoFar);
      process.exit(1);
      return;
    }

    var handlerName = '_poll_' + this.state.replace(/-/g, '_');
    this[handlerName]().then(function(pollAgain) {
      if (pollAgain === 'done') {
        process.exit(0);
      }

      console.log('call completed, again?', pollAgain);
      this.timer = setTimeout(
        this._bound_poll,
        (pollAgain === 'immediate') ? 0 : this.POLL_INTERVAL_MS);
    }.bind(this), function(err) {
      console.error('Fatal poller problem in state', this.state, err);
      process.exit(2);
    }.bind(this));
  },

  _poll_pull_request: function() {
    return getGithubPullRequestTravisLink(this.githubInfo).then(function(trav) {
      if (!trav) {
        return 'later';
      }

      this.state = 'travis-build';
      this.buildInfo = trav;
      return 'immediate';
    }.bind(this));
  },

  _poll_travis_build: function() {
    return getTravisBuildStatus(this.buildInfo).then(function(state) {
      if (state) {
        this.setNewBuildState(state);
        // the build is all done if it's not created/started
        if (state.state !== 'created' &&
            state.state !== 'started') {
          return 'done';
        }
      }

      return 'later';
    }.bind(this));
  },
};

function processUrl(urlStr, program) {
  var linkInfo = analyzeLink(urlStr);
  console.log(linkInfo);

  if (linkInfo.type === 'unknown') {
    console.error(ERROR_STRINGS[linkInfo.err], linkInfo.errArgs);
    return;
  }

  var details = {};
  if (linkInfo.type === 'pull-request') {
    details.githubInfo = linkInfo;
  }
  else if (linkInfo.type === 'travis-build') {
    details.buildInfo = linkInfo;
  }

  var prober = new PollingProber(linkInfo.type, details);
  bindCommandsToProber(prober, program);
  prober.poll();
}

var ERROR_STRINGS = {
  'unsupported-url': 'Unsupported URL thing.'
};

var JOB_COLORS = {
  created: 'black',
  started: 'yellow',
  passed: 'green',
  failed: 'red',
  errored: 'purple',
};

var templateExpansions = {
  statecolor: function(state) {
    return JOB_COLORS[state.state];
  },

  jobcolors: function(state) {
    return state.jobs.map(function(job) {
      return JOB_COLORS[job.state];
    }).join(' ');
  }
};

function bindCommand(cmdstr) {
  return function(state) {
    console.log('state update received!!!', state);
    var expanded = cmdstr.replace(/{{([^}]+)}}/g, function expander(omatch, name) {
      if (!(name in templateExpansions)) {
        console.warn('no template expansion for:', name);
        return '';
      }
      return templateExpansions[name](state);
    });

    console.log('expanded to:', expanded);
    childProcess.exec(expanded);
  };
}

function bindCommandsToProber(prober, program) {
  function bindHelper(eventName) {
    var cmd = program[eventName];
    if (!cmd) {
      return;
    }

    console.log('binding to', eventName, cmd);
    prober.events.on(eventName, bindCommand(cmd));
  }

  bindHelper('stateUpdate');
}

exports.main = function(argsToParse) {
  var program = require('commander');
  program
    .usage('[url]')
    .option('--state-update <cmd>',
            'Command to run whenever any state change occurs')
    .option('--job-any <cmd>',
            'Command to run when a job starts/stops')
    .option('--job-start <cmd>',
            'Command to run when a job starts')
    .option('--job-end <cmd>',
            'Command to run when a job ends')
    .option('--job-pass <cmd>',
            'Command to run when a job passes')
    .option('--job-fail <cmd>',
            'Command to run when a job fails')
    .option('--job-errors <cmd>',
            'Command to run when a job errors out / gets canceled')
    .parse(argsToParse);

  if (program.args.length === 1) {
    processUrl(program.args[0], program);
  }
  else {
    program.help();
  }
};
