// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

angular.module('syncthing.core')
    .factory('selectiveSyncService', ['$http', function ($http) {
        'use strict';

        var INCLUDE_LINE = '#include .stselective';
        var _state = {};

        function st(folderId) {
            if (!_state[folderId]) {
                _state[folderId] = { enabled: false, paths: new Set(), touched: false };
            }
            return _state[folderId];
        }

        function load(folderId) {
            return $http.get(urlbase + '/db/selective?folder=' + encodeURIComponent(folderId))
                .then(function (r) {
                    var s = st(folderId);
                    if (!s.touched) {
                        s.enabled = !!r.data.enabled;
                        s.paths = new Set(r.data.paths || []);
                    }
                });
        }

        function save(folderId) {
            var s = st(folderId);
            var paths = s.enabled ? Array.from(s.paths).sort() : [];

            return $http.post(urlbase + '/db/selective?folder=' + encodeURIComponent(folderId), { paths: paths })
                .then(function () {
                    return $http.get(urlbase + '/db/ignores?folder=' + encodeURIComponent(folderId));
                }).then(function (r) {
                    var lines = (r.data && r.data.ignore) || [];
                    var has = lines.indexOf(INCLUDE_LINE) !== -1;
                    if (s.enabled && !has) {
                        lines = [INCLUDE_LINE].concat(lines);
                    } else if (!s.enabled && has) {
                        lines = lines.filter(function (l) { return l !== INCLUDE_LINE; });
                    } else {
                        return;
                    }
                    return $http.post(urlbase + '/db/ignores?folder=' + encodeURIComponent(folderId), { ignore: lines });
                });
        }

        function enable(folderId)    { var s = st(folderId); s.enabled = true;  s.touched = true; }
        function disable(folderId)   { var s = st(folderId); s.enabled = false; s.touched = true; }
        function isEnabled(folderId) { return !!st(folderId).enabled; }
        function isTouched(folderId) { return !!(_state[folderId] && _state[folderId].touched); }

        function selectPath(folderId, path) {
            var s = st(folderId);
            s.paths.add(path);
            s.touched = true;
        }

        function deselectPath(folderId, path) {
            var s = st(folderId);
            s.paths.delete(path);
            // Also remove any children
            var prefix = path + '/';
            s.paths.forEach(function (p) { if (p.indexOf(prefix) === 0) s.paths.delete(p); });
            s.touched = true;
        }

        function getSelectedPaths(folderId) { return Array.from(st(folderId).paths).sort(); }

        function isPathSelected(folderId, path) {
            var s = _state[folderId];
            if (!s) return false;
            if (s.paths.has(path)) return true;
            // Check if any ancestor is selected
            var parts = path.split('/');
            for (var i = parts.length - 1; i > 0; i--) {
                var anc = parts.slice(0, i).join('/');
                if (anc && s.paths.has(anc)) return true;
            }
            return false;
        }

        function isPathPartial(folderId, path) {
            var s = _state[folderId];
            if (!s || isPathSelected(folderId, path)) return false;
            var prefix = path + '/';
            var found = false;
            s.paths.forEach(function (p) { if (p.indexOf(prefix) === 0) found = true; });
            return found;
        }

        function clearSelections(folderId) {
            var s = st(folderId);
            s.paths = new Set();
            s.touched = true;
        }

        return { load: load, save: save, enable: enable, disable: disable, isEnabled: isEnabled,
                 isTouched: isTouched, selectPath: selectPath, deselectPath: deselectPath,
                 getSelectedPaths: getSelectedPaths, isPathSelected: isPathSelected,
                 isPathPartial: isPathPartial, clearSelections: clearSelections };
    }]);
