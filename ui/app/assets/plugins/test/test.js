/*
 Copyright (C) 2013 Typesafe, Inc <http://typesafe.com>
 */
define(['text!./test.html', 'css!./test.css', 'main/pluginapi', 'services/build'], function(template, css, api, build) {
  var ko = api.ko;
  var sbt = api.sbt;

  var Outcome = {
    PASSED: 'passed',
    FAILED: 'failed',
    ERROR: 'error',
    SKIPPED: 'skipped',
    // PENDING doesn't arrive from server, it's just a state we use locally
    PENDING: 'pending'
  };

  // TODO - Other widgety things here.
  var TestResult = api.Class({
    init: function(config) {
      var self = this;
      self.name = config.name;
      self.outcome = ko.observable(config.outcome);
      self.description = ko.observable(config.description);
      self.outcomeClass = ko.computed(function() {
        var current = self.outcome();
        if (current === Outcome.PASSED || current === Outcome.PENDING) {
          return current;
        } else {
          return Outcome.FAILED;
        }
      });
    },
    // Update our state from an event.
    update: function(event) {
      this.description(event.description);
      this.outcome(event.outcome);
    }
  });
  var testConsole = api.PluginWidget({
    id: 'test-result-widget',
    title: 'Testing',
    template: template,
    init: function(parameters) {
      var self = this;
      self.results = ko.observableArray();
      self.testStatus = ko.observable('Waiting to test');
      self.log = build.log;
      // TODO - Store state beyond the scope of this widget!
      // We should probably be listening to tests *always*
      // and displaying latest status *always*.
      self.hasResults = ko.computed(function() {
        return self.results().length > 0;
      });
      self.testFilter = ko.observable('all');
      self.filterTestsText = ko.computed(function() {
        if(self.testFilter() == 'all') {
          return 'Show only failures';
        }
        return 'Show all tests';
      });
      self.displayedResults = ko.computed(function() {
        if(self.testFilter() == 'failures') {
          return ko.utils.arrayFilter(self.results(), function(item) {
            return item.outcome() != Outcome.PASSED;
          });
        }
        return self.results();
      });
      // Rollup results.
      self.resultStats = ko.computed(function() {
        var results = {
            passed: 0,
            failed: 0
        };
        $.each(self.results(), function(idx, result) {
          if(result.outcome() != Outcome.PASSED) {
            results.failed = results.failed + 1;
          } else {
            results.passed = results.passed + 1;
          }
        });
        return results;
      });

      this.activeTask = ko.observable(""); // empty string or taskId
      this.haveActiveTask = ko.computed(function() {
        return self.activeTask() != "";
      }, this);
      this.startStopLabel = ko.computed(function() {
        if (self.haveActiveTask())
          return "Stop";
        else
          return "Start";
      }, this);
      this.rerunOnBuild = ko.observable(true);
      this.restartPending = ko.observable(false);
      this.lastTaskFailed = ko.observable(false);
      this.status = ko.computed(function() {
        var anyFailures = this.lastTaskFailed() || this.resultStats().failed > 0;

        if (this.haveActiveTask())
          return api.STATUS_BUSY;
        else if (anyFailures)
          return api.STATUS_ERROR;
        else
          return api.STATUS_DEFAULT;
      }, this);

      api.events.subscribe(function(event) {
        return event.type == 'CompileSucceeded';
      },
      function(event) {
        self.onCompileSucceeded(event);
      });
    },
    filterTests: function() {
      // TODO - More states.
      if(this.testFilter() == 'all') {
        this.testFilter('failures')
      } else {
        this.testFilter('all')
      }
    },
    doAfterTest: function() {
      var self = this;
      self.activeTask("");
      if (self.restartPending()) {
        self.doTest(false); // false=!triggeredByBuild
      }
    },
    doTest: function(triggeredByBuild) {
      var self = this;

      self.log.clear();
      self.results.removeAll();
      self.testStatus('Running tests...')

      if (triggeredByBuild) {
        self.log.info("Build succeeded, testing...");
      } else if (self.restartPending()) {
        self.log.info("Restarting...");
      } else {
        self.log.info("Testing...");
      }

      self.restartPending(false);

      // TODO - Do we want to clear the test data we had previously
      // or append?  Tests may disappear and we'd never know...

      var taskId = sbt.runTask({
        task: 'test',
        onmessage: function(event) {
          if (self.log.event(event)) {
            // nothing
          } else if (event.type == 'GenericEvent' &&
              event.task == 'test' &&
              event.id == 'result') {
            self.updateTest(event.params);
          } else if (event.type == 'Started') {
            // this is expected when we start a new sbt, but we don't do anything with it
          } else {
            self.log.leftoverEvent(event);
          }
        },
        success: function(data) {
          debug && console.log("test result: ", data);

          if (data.type == 'GenericResponse') {
            self.log.info('Testing complete.');
            self.testStatus('Testing complete.');
          } else {
            self.log.error('Unexpected reply: ' + JSON.stringify(data));
            self.testStatus("Unexpected: " + JSON.stringify(data));
          }
          self.lastTaskFailed(false);
          self.doAfterTest();
        },
        failure: function(status, message) {
          debug && console.log("test failed: ", status, message)
          self.log.error("Failed: " + status + ": " + message);
          self.testStatus('Testing error: ' + message);
          self.lastTaskFailed(true);
          self.doAfterTest();
        }
      });
      self.activeTask(taskId);
    },
    updateTest: function(params) {
      var match = ko.utils.arrayFirst(this.results(), function(item) {
        return params.name === item.name;
      });
      if(!match) {
        var test = new TestResult(params);
        this.results.push(test);
      } else {
        match.update(params);
      }
    },
    onCompileSucceeded: function(event) {
      var self = this;
      if (self.rerunOnBuild() && !self.haveActiveTask()) {
        self.doTest(true); // true=triggeredByBuild
      }
    },
    doStop: function() {
      var self = this;
      if (self.haveActiveTask()) {
        sbt.killTask({
          taskId: self.activeTask(),
          success: function(data) {
            debug && console.log("kill success: ", data)
          },
          failure: function(status, message) {
            debug && console.log("kill failed: ", status, message)
            self.log.error("HTTP request to kill task failed: " + message)
          }
        });
      }
    },
    startStopButtonClicked: function(self) {
      debug && console.log("Start/Stop was clicked");
      if (self.haveActiveTask()) {
        self.restartPending(false);
        self.doStop();
      } else {
        self.doTest(false); // false=!triggeredByBuild
      }
    },
    restartButtonClicked: function(self) {
      debug && console.log("Restart was clicked");
      self.doStop();
      self.restartPending(true);
    }
  });

  return api.Plugin({
    id: 'test',
    name: "Test",
    icon: 'ꙫ',
    url: "#test",
    routes: {
      'test': function() { api.setActiveWidget(testConsole); }
    },
    widgets: [testConsole],
    status: testConsole.status
  });
});
