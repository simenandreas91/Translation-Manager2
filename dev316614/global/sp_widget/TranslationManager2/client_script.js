api.controller = function($scope, $q) {
  var c = this;
  c.data = c.data || {};
  var defaultEditableFields = ['label', 'plural', 'hint', 'help'];

  c.state = {
    searchTerm: '',
    tableName: c.data.selectedTable || '',
    lastSearchTerm: '',
    isSearching: false,
    results: [],
    message: '',
    error: '',
    sourceType: c.data.sourceType || 'table'
  };

  c.bulk = {
    field: '',
    value: '',
    options: [],
    applying: false,
    appliedCount: 0,
    failedCount: 0,
    message: '',
    error: ''
  };

  c.search = function() {
    c.state.error = '';
    c.state.message = '';

    var term = (c.state.searchTerm || '').trim();
    var tableName = (c.state.tableName || '').trim();
    var sourceType = c.state.sourceType || 'table';
    if (!term) {
      c.state.error = 'Enter text to search.';
      c.state.results = [];
      refreshBulkOptions();
      return;
    }
    if (sourceType === 'table' && !tableName) {
      c.state.error = 'Select a table to search.';
      c.state.results = [];
      refreshBulkOptions();
      return;
    }

    console.log('[TM2] Searching for translations:', term, 'in table', tableName);
    c.state.isSearching = true;
    c.server
      .get({action: 'search', searchTerm: term, tableName: tableName, sourceType: sourceType})
      .then(function(response) {
        var payload = (response || {}).data || {};
        if (payload.serverError) {
          c.state.error = payload.serverError;
          c.state.results = [];
          refreshBulkOptions();
          console.warn('[TM2] Server error:', payload.serverError);
          return;
        }

        if (payload.debugMessages && payload.debugMessages.length) {
          console.log('[TM2] Server debug messages:', payload.debugMessages);
        }

        c.state.results = mapResults(payload.results || []);
        refreshBulkOptions();
        console.log('[TM2] Search response:', payload);
        if (payload.selectedTable) {
          c.state.tableName = payload.selectedTable;
        }
        if (payload.sourceType) {
          c.state.sourceType = payload.sourceType;
        }

        if (payload.errorMessage) {
          c.state.error = payload.errorMessage;
        } else if (!c.state.results.length) {
          c.state.message = 'No matches found.';
        } else {
          c.state.message = c.state.results.length === 1 ?
            '1 match found.' :
            c.state.results.length + ' matches found.';
        }

        c.state.lastSearchTerm = term;
      })
      .catch(function() {
        c.state.error = 'Unable to search translations right now.';
      })
      .finally(function() {
        c.state.isSearching = false;
      });
  };

  c.setSourceType = function(type) {
    var allowed = ['table', 'message', 'translated'];
    var normalized = allowed.indexOf(type) > -1 ? type : 'table';
    if (c.state.sourceType === normalized) {
      return;
    }
    c.state.sourceType = normalized;
    if (normalized !== 'table') {
      c.state.tableName = '';
    }
  };

  c.hasChanges = function(result) {
    if (!result || !result.__draft) {
      return false;
    }

    var fields = getEditableFields(result);
    return fields.some(function(field) {
      return (result.__draft[field] || '') !== (result[field] || '');
    });
  };

  c.resetDraft = function(result) {
    if (!result) {
      return;
    }

    result.__draft = buildDraft(result, getEditableFields(result));
    result.__message = '';
    result.__error = '';
  };

  c.saveResult = function(result) {
    if (!result || !c.hasChanges(result) || result.__saving) {
      return $q.when();
    }

    result.__saving = true;
    result.__message = '';
    result.__error = '';

    var payload = {
      action: 'update',
      record: angular.extend(
        {sys_id: result.sys_id, recordType: result.recordType},
        result.__draft
      )
    };

    console.log('[TM2] Saving translation for', result.sys_id, payload.record);
    return invokeUpdateRequest(payload)
      .then(function(response) {
        console.log('[TM2] Raw update response object:', response);
        var data = response && (response.data || response.result) ? (response.data || response.result) : (response || {});
        if (data.debugMessages && data.debugMessages.length) {
          console.log('[TM2] Server debug messages:', data.debugMessages);
        }

        console.log('[TM2] Save response:', data);
        if (data.serverError) {
          result.__error = data.serverError;
          console.warn('[TM2] Server error:', data.serverError);
          return;
        }

        var updateResponse = data.updateResponse || {};

        if (!updateResponse.success) {
          result.__error = updateResponse.message || 'Unable to save changes.';
          return;
        }

        var updatedRecord = updateResponse.record || {};

        var fields = getEditableFields(result);
        fields.forEach(function(field) {
          if (updatedRecord.hasOwnProperty(field)) {
            result[field] = updatedRecord[field] || '';
          } else {
            result[field] = result.__draft[field] || '';
          }
        });

        if (angular.isArray(updatedRecord.editableFields) && updatedRecord.editableFields.length) {
          result.editableFields = updatedRecord.editableFields;
        }
        if (updatedRecord.recordType) {
          result.recordType = updatedRecord.recordType;
        }

        result.__editableFields = getEditableFields(result);
        result.__draft = buildDraft(result, result.__editableFields);
        result.__message = 'Changes saved.';
      })
      .catch(function() {
        result.__error = 'Unable to reach the server.';
      })
      .finally(function() {
        result.__saving = false;
      });
  };

  c.applyBulkChange = function() {
    if (!c.state.results.length || c.bulk.applying) {
      return;
    }

    c.bulk.error = '';
    c.bulk.message = '';

    var field = c.bulk.field;
    if (!field) {
      c.bulk.error = 'Select a field to update.';
      return;
    }

    var value = c.bulk.value || '';
    var targets = c.state.results.filter(function(result) {
      return result &&
        !result.__saving &&
        result.__draft &&
        Object.prototype.hasOwnProperty.call(result.__draft, field);
    });

    if (!targets.length) {
      c.bulk.error = 'No results can be updated with "' + field + '".';
      return;
    }

    c.bulk.applying = true;
    c.bulk.appliedCount = 0;
    c.bulk.failedCount = 0;

    targets.reduce(function(sequence, result) {
      return sequence.then(function() {
        result.__draft[field] = value;
        return c.saveResult(result).then(function() {
          if (result.__error) {
            c.bulk.failedCount += 1;
          } else {
            c.bulk.appliedCount += 1;
          }
        });
      });
    }, $q.when())
      .then(function() {
        if (c.bulk.appliedCount) {
          c.bulk.message = 'Updated ' + c.bulk.appliedCount + ' ' + (c.bulk.appliedCount === 1 ? 'record' : 'records') + '.';
        }
        if (c.bulk.failedCount) {
          c.bulk.error = c.bulk.failedCount + ' ' + (c.bulk.failedCount === 1 ? 'record failed' : 'records failed') + ' to update.';
        }
      })
      .catch(function() {
        c.bulk.error = 'Unable to apply changes to all records.';
      })
      .finally(function() {
        c.bulk.applying = false;
      });
  };

  c.clearBulkInput = function() {
    c.bulk.value = '';
    c.bulk.message = '';
    c.bulk.error = '';
  };

  c.getBulkFieldLabel = function(field) {
    if (!field) {
      return '';
    }
    return String(field)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function(char) {
        return char.toUpperCase();
      });
  };

  function mapResults(records) {
    return records.map(function(record) {
      record.__editableFields = getEditableFields(record);
      record.__draft = buildDraft(record, record.__editableFields);
      record.__saving = false;
      record.__message = '';
      record.__error = '';
      return record;
    });
  }

  function buildDraft(record, editableFields) {
    var draft = {};
    var fields = editableFields || getEditableFields(record);
    fields.forEach(function(field) {
      draft[field] = (record && record[field]) || '';
    });
    return draft;
  }

  function getEditableFields(record) {
    if (record && Array.isArray(record.__editableFields) && record.__editableFields.length) {
      return record.__editableFields;
    }
    if (record && Array.isArray(record.editableFields) && record.editableFields.length) {
      return record.editableFields;
    }
    return defaultEditableFields;
  }

  function invokeUpdateRequest(payload) {
    payload = payload || {};
    var previousValues = {};

    Object.keys(payload).forEach(function(key) {
      previousValues[key] = {
        exists: Object.prototype.hasOwnProperty.call(c.data, key),
        value: c.data[key]
      };
      c.data[key] = payload[key];
    });

    return c.server.update()
      .finally(function() {
        Object.keys(payload).forEach(function(key) {
          var previous = previousValues[key];
          if (previous.exists) {
            c.data[key] = previous.value;
          } else {
            delete c.data[key];
          }
        });
      });
  }

  function refreshBulkOptions() {
    var seen = {};
    var options = [];
    c.bulk.message = '';
    c.bulk.error = '';
    c.bulk.appliedCount = 0;
    c.bulk.failedCount = 0;
    c.bulk.applying = false;

    (c.state.results || []).forEach(function(result) {
      var fields = getEditableFields(result);
      fields.forEach(function(field) {
        if (!seen[field]) {
          seen[field] = true;
          options.push(field);
        }
      });
    });

    options.sort();
    c.bulk.options = options;

    if (!options.length) {
      c.bulk.field = '';
      return;
    }

    if (options.indexOf(c.bulk.field) === -1) {
      c.bulk.field = pickDefaultBulkField(options);
    }
  }

  function pickDefaultBulkField(options) {
    var priority = ['value', 'message', 'label', 'plural', 'hint', 'help'];
    for (var i = 0; i < priority.length; i++) {
      if (options.indexOf(priority[i]) > -1) {
        return priority[i];
      }
    }
    return options[0];
  }

};
