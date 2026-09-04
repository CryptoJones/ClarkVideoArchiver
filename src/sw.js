// Chrome MV3 allows exactly one service_worker file, so pull in the shared
// helpers here. Firefox instead lists both files in background.scripts and
// never loads this shim.
importScripts('common.js', 'background.js');
