# Quick Examples #

These are things that work now (if you "npm install -g gaudy-leds", for
example):

```
travis-build-watcher --state-update "gaudy-leds set {{jobcolors}}"  https://github.com/mozilla-b2g/gaia/pull/17940
```

```
travis-build-watcher --state-update "gaudy-leds set {{jobcolors}}" https://travis-ci.org/mozilla-b2g/gaia/builds/22183092
```

Everything below this is some combination of reality and dreams all smooshed
together.

# Overview #

We help you track a Travis build in-progress.  We do this by polling using the
Travis API.  Travis does have some type of http://pusher.com/ API that it uses
in its UI.  However, it is not defined as part of the public API and potentially
incurs some type of cost of Travis.  Also, naive monitoring of the websocket
stream as used by the UI does not perform filtering.

I am considering polling at a low-rate for JSON data to be sufficiently friendly
as compared to the expected overhead of leaving one or more travis-ci.org
windows open in the browser.  I don't know about you, but I open them and forget
about them for extended periods of time.  A script with failsafe timeouts seems
generally safer.

## General Operation ##

You run the command giving us a URL and a series of scripts to run as various
things happen.  We daemonize ourselves, we figure out how to map the URL to a
travis build.  We poll the job for progress, running actions as appropriate.
When the build completes, our program terminates.

Runaway behaviour on our part is prevented by associating a cost with our
various requests and terminating if we cross the cost threshold.  We also
enforce program termination after a long timeout.  The goals are to prevent
inadvertent DoS or excessive resource consumption of github and travis resources
or us clogging up your machine with dead processes or just spinning in buggy
infinite loops.

# Action Templating #



# Actions #

NOTE! This is all speculative stuff right now except for "--state-update"

## State Updates ##

Invoke a script every time we update our knowledge of the build.  This includes
polling and the last thing that happens.

## Job Transitions ##

Invoke a script when a job that's part of a build transitions.

Jobs can have any of the following states:
- passed
- failed
- errored

- `--job-any`: Invoke when a job starts/stops
- `--job-start`: Invoke when a job starts.  This will not be invoked if the job
   is canceled before starting or transitions to an end state without us
   observing it actively running.
- `--job-end`: Invoke when a job ends.  If you want to break this out further,
   the following actions are mutually exclusive; only one will fire for a job
   unless it gets rescheduled.
  - `--job-pass`: Invoke when a job passes
  - `--job-fail`: Invoke when a job fails
  - `--job-errors`: Invoke when a job errors out / gets canceled.

# Examples #

## Actions ##

All actions currently just involve us building a command line and invoking some
external script.

### Generate a desktop-notification ###

Let's assume you're on linux and you have notify-send installed (provided by
libnotify-bin on Ubuntu).

## GitHub-based watches ##

### Watch a Specific Pull-Request ###

You've got a github pull request URL.  Tell us it, we'll find the travis build
link or wait for it to show up, then watch that build.

```
watch-pull-request.js 
```

### Wait for a New Pull Request ###

Point us at the github repo that a pull request should soon show up at.  We
can infer this from the "origin" remote of the current directory's git repo.

```
```

## Travis-based watches ##

### Given a build URL ###
