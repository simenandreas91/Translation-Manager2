(function() {
  data.maxResults = 50;
  data.results = [];
  data.searchTerm = '';
  data.selectedTable = '';
  data.appliedTables = [];
  data.errorMessage = '';
  data.updateResponse = {};
  data.serverError = '';
  data.debugMessages = [];
  data.lastInput = input || {};

  try {
    logInfo('TM2 widget invoked with action: ' + (input && input.action ? input.action : 'none'));
    logInfo('TM2 raw input: ' + stringifyInput(input));
    handleAction();
  } catch (err) {
    logError('TM2 widget crashed: ' + err);
    data.serverError = (err && err.message) ? err.message : 'Unexpected server error.';
  }

})();

function handleAction() {
  if (!input || !input.action) {
    return;
  }

  if (input.action === 'search') {
    var term = sanitizeSearchTerm(input.searchTerm);
    var tableName = sanitizeTableName(input.tableName);
    data.searchTerm = term;
    data.selectedTable = tableName;
    logInfo('TM2 search term after sanitize: [' + term + ']');
    logInfo('TM2 table filter: [' + tableName + ']');

    if (!term) {
      data.errorMessage = 'Enter text to search for translations.';
      return;
    }

    if (!tableName) {
      data.errorMessage = 'Provide a table to search within.';
      return;
    }

    var tablesToQuery = resolveTableHierarchy(tableName);
    if (!tablesToQuery.length) {
      data.errorMessage = 'Table "' + tableName + '" was not found.';
      return;
    }

    data.appliedTables = tablesToQuery;
    logInfo('TM2 tables considered: ' + tablesToQuery.join(', '));

    data.results = searchDocumentation(term, tablesToQuery, data.maxResults);
    data.errorMessage = '';
  }

  if (input.action === 'update') {
    data.updateResponse = updateDocumentation(input.record);
  }
}

function searchDocumentation(term, tableNames, limit) {
  var records = [];
  var gr = new GlideRecordSecure('sys_documentation');
  var encodedQuery = buildSearchQuery(term);

  if (tableNames && tableNames.length) {
    gr.addQuery('name', 'IN', tableNames.join(','));
  }
  gr.addEncodedQuery(encodedQuery);
  logInfo('TM2 encoded query: ' + encodedQuery);
  gr.orderBy('name');
  gr.orderBy('element');
  gr.setLimit(limit || 50);
  gr.query();

  while (gr.next()) {
    records.push(serializeRecord(gr));
  }

  logInfo('TM2 search returned ' + records.length + ' records.');
  return records;
}

function updateDocumentation(payload) {
  var response = {
    success: false,
    message: 'Unexpected error.'
  };

  if (!payload || !payload.sys_id) {
    response.message = 'Missing record identifier.';
    return response;
  }

  var gr = new GlideRecord('sys_documentation');
  if (!gr.get(payload.sys_id)) {
    response.message = 'Record not found.';
    return response;
  }

  var editableFields = ['label', 'plural', 'hint', 'help'];
  var hasChanges = false;

  editableFields.forEach(function(field) {
    if (payload.hasOwnProperty(field) && payload[field] !== undefined && payload[field] !== null) {
      gr.setValue(field, payload[field]);
      hasChanges = true;
    }
  });

  if (!hasChanges) {
    response.message = 'No changes detected.';
    return response;
  }

  gr.setWorkflow(false);
  var updateResult = gr.update();

  if (!updateResult) {
    response.message = 'Unable to update record.';
    return response;
  }

  response.success = true;
  response.message = 'Translation updated.';
  response.record = serializeRecord(gr);
  return response;
}

function serializeRecord(gr) {
  return {
    sys_id: gr.getUniqueValue(),
    name: gr.getValue('name') || '',
    element: gr.getValue('element') || '',
    label: gr.getValue('label') || '',
    plural: gr.getValue('plural') || '',
    hint: gr.getValue('hint') || '',
    help: gr.getValue('help') || '',
    language: gr.getValue('language') || '',
    scope: resolveScope(gr)
  };
}

function resolveScope(gr) {
  if (!gr.isValidField('sys_scope')) {
    return '';
  }

  var displayValue = gr.getDisplayValue('sys_scope');

  try {
    var ref = gr.sys_scope.getRefRecord();
    if (ref && ref.isValidRecord && ref.isValidRecord()) {
      var scopeName = ref.getValue('scope');
      if (scopeName) {
        return scopeName;
      }
    }
  } catch (ignored) {
    /* ignore ref resolution errors */
  }

  return displayValue || '';
}

function buildSearchQuery(term) {
  var encodedTerm = term.replace(/\^/g, '');
  var clauses = ['label', 'plural', 'hint', 'help'].map(function(field) {
    return field + 'LIKE' + encodedTerm;
  });
  return clauses.join('^OR');
}

function sanitizeSearchTerm(term) {
  if (!term) {
    return '';
  }

  return String(term)
    .replace(/\^/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeTableName(tableName) {
  if (!tableName) {
    return '';
  }

  return String(tableName)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

function logInfo(msg) {
  pushDebug('INFO', msg);
  gs.info('[TM2] ' + msg, 'TranslationManager2');
}

function logError(msg) {
  pushDebug('ERROR', msg);
  gs.error('[TM2] ' + msg, 'TranslationManager2');
}

function pushDebug(level, msg) {
  if (!data.debugMessages) {
    data.debugMessages = [];
  }
  data.debugMessages.push('[' + level + '] ' + msg);
}

function stringifyInput(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return '[unserializable input]';
  }
}

function resolveTableHierarchy(tableName) {
  var names = [];
  if (!tableName) {
    return names;
  }

  var gr = new GlideRecord('sys_db_object');
  if (!gr.get('name', tableName)) {
    logError('TM2 table not found: ' + tableName);
    return names;
  }

  names.push(gr.getValue('name'));

  var current = gr;
  var guard = 0;
  while (current.super_class && guard < 20) {
    guard++;
    var parent = current.super_class.getRefRecord();
    if (!parent || !parent.isValidRecord()) {
      break;
    }
    var parentName = parent.getValue('name');
    if (!parentName) {
      break;
    }
    names.push(parentName);
    current = parent;
  }

  return names;
}
