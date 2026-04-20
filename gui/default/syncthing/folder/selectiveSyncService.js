// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

angular.module('syncthing.core')
    .factory('selectiveSyncService', ['$http', '$q', function ($http, $q) {
        'use strict';

        var BEGIN_MARKER = '// === Selective Sync (managed — do not edit below) ===';
        var END_MARKER = '// === End Selective Sync ===';

        // _state: { folderId: { userLines: [], selected: Set(), loaded: bool } }
        var _state = {};

        function ensureState(folderId) {
            if (!_state[folderId]) {
                _state[folderId] = {
                    userLines: [],
                    selected: new Set(),
                    loaded: false
                };
            }
            return _state[folderId];
        }

        function stripTrailingBlanks(lines) {
            var out = lines.slice();
            while (out.length > 0 && out[out.length - 1] === '') {
                out.pop();
            }
            return out;
        }

        function parseStignore(lines) {
            lines = lines || [];
            var beginIdx = lines.indexOf(BEGIN_MARKER);
            var endIdx = lines.indexOf(END_MARKER);

            if (beginIdx === -1 && endIdx === -1) {
                return { enabled: false, userLines: lines.slice(), selected: [] };
            }
            if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
                console.warn('selectiveSyncService: .stignore managed block is corrupt (only one marker found)');
                return { enabled: false, userLines: lines.slice(), selected: [] };
            }

            var userLines = lines.slice(0, beginIdx).concat(lines.slice(endIdx + 1));
            var managed = lines.slice(beginIdx + 1, endIdx);
            var selected = managed
                .filter(function (l) { return l.indexOf('!/') === 0; })
                .map(function (l) { return l.slice(1); });
            return { enabled: true, userLines: userLines, selected: selected };
        }

        function serializeStignore(userLines, selectedPaths) {
            var stripped = stripTrailingBlanks(userLines || []);
            var sorted = (selectedPaths || []).slice().sort();
            var block = [BEGIN_MARKER];
            block.push('// This block is managed by the Selective Sync tab and will be overwritten on save.');
            sorted.forEach(function (p) {
                block.push('!' + p);
            });
            block.push('*');
            block.push(END_MARKER);
            if (stripped.length === 0) {
                return block;
            }
            return stripped.concat(['']).concat(block);
        }

        function loadFromIgnores(folderId) {
            var st = ensureState(folderId);
            return $http.get(urlbase + '/db/ignores?folder=' + encodeURIComponent(folderId))
                .then(function (response) {
                    var lines = (response.data && response.data.ignore) || [];
                    var parsed = parseStignore(lines);
                    st.userLines = parsed.userLines;
                    st.selected = new Set(parsed.selected);
                    st.enabled = parsed.enabled;
                    st.loaded = true;
                    return st;
                });
        }

        function saveToIgnores(folderId) {
            var st = ensureState(folderId);
            var lines;
            if (st.enabled) {
                lines = serializeStignore(st.userLines, Array.from(st.selected));
            } else {
                lines = stripTrailingBlanks(st.userLines || []);
            }
            return $http.post(urlbase + '/db/ignores?folder=' + encodeURIComponent(folderId), {
                ignore: lines
            });
        }

        function enable(folderId) {
            var st = ensureState(folderId);
            st.enabled = true;
            st.touched = true;
            if (!st.selected) {
                st.selected = new Set();
            }
        }

        function disable(folderId) {
            var st = ensureState(folderId);
            st.enabled = false;
            st.touched = true;
            st.selected = new Set();
        }

        function isTouched(folderId) {
            var st = _state[folderId];
            return !!(st && st.touched);
        }

        function isEnabled(folderId) {
            var st = _state[folderId];
            return !!(st && st.enabled);
        }

        function selectPath(folderId, path) {
            var st = ensureState(folderId);
            st.touched = true;
            st.selected.add(path);
        }

        function deselectPath(folderId, path) {
            var st = ensureState(folderId);
            st.touched = true;
            st.selected.delete(path);
            var prefix = path + '/';
            var toDelete = [];
            st.selected.forEach(function (p) {
                if (p.indexOf(prefix) === 0) {
                    toDelete.push(p);
                }
            });
            toDelete.forEach(function (p) { st.selected.delete(p); });
        }

        function getSelectedPaths(folderId) {
            var st = ensureState(folderId);
            return Array.from(st.selected).sort();
        }

        function isPathSelected(folderId, path) {
            var st = _state[folderId];
            if (!st) {
                return false;
            }
            if (st.selected.has(path)) {
                return true;
            }
            var parts = path.split('/');
            // Walk up ancestor paths: e.g., /a/b/c -> /a/b, /a
            for (var i = parts.length - 1; i > 0; i--) {
                var ancestor = parts.slice(0, i).join('/');
                if (ancestor && st.selected.has(ancestor)) {
                    return true;
                }
            }
            return false;
        }

        function isPathPartial(folderId, path) {
            var st = _state[folderId];
            if (!st) {
                return false;
            }
            if (isPathSelected(folderId, path)) {
                return false;
            }
            var prefix = path + '/';
            var found = false;
            st.selected.forEach(function (p) {
                if (p.indexOf(prefix) === 0) {
                    found = true;
                }
            });
            return found;
        }

        function clearSelections(folderId) {
            var st = ensureState(folderId);
            st.touched = true;
            st.selected = new Set();
        }

        function getState(folderId) {
            return ensureState(folderId);
        }

        return {
            parseStignore: parseStignore,
            serializeStignore: serializeStignore,
            loadFromIgnores: loadFromIgnores,
            saveToIgnores: saveToIgnores,
            enable: enable,
            disable: disable,
            isEnabled: isEnabled,
            selectPath: selectPath,
            deselectPath: deselectPath,
            getSelectedPaths: getSelectedPaths,
            isPathSelected: isPathSelected,
            isPathPartial: isPathPartial,
            clearSelections: clearSelections,
            getState: getState,
            isTouched: isTouched
        };
    }]);
