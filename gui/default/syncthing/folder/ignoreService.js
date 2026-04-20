// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

// ignoreService: read/write .stignore via the REST API.
//
// This service is stateless — every operation reads current patterns fresh,
// mutates in memory, and writes back. All path arguments use a leading slash.

angular.module('syncthing.core')
    .factory('ignoreService', ['$http', function ($http) {
        'use strict';

        // A pattern is "literal" if it's a plain path (no glob chars, no #include,
        // no comment). We only auto-mutate literal patterns. Complex patterns are
        // surfaced to the user as-is.
        function isLiteral(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            return p[0] !== '#' && !/[*?\[{]/.test(p);
        }

        // Normalise a path to always have a leading slash.
        function norm(path) {
            return (path[0] === '/') ? path : '/' + path;
        }

        // Ensure a pattern has a leading slash (strips negation prefix first).
        // Used so we can compare patterns to normalised paths on equal footing.
        function withSlash(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            return (p[0] === '/') ? p : '/' + p;
        }

        function getPatterns(folderId) {
            return $http.get(urlbase + '/db/ignores?folder=' + encodeURIComponent(folderId))
                .then(function (r) { return (r.data && r.data.ignore) || []; });
        }

        function setPatterns(folderId, patterns) {
            return $http.post(
                urlbase + '/db/ignores?folder=' + encodeURIComponent(folderId),
                { ignore: patterns }
            );
        }

        // Toggle sync for a path.
        //
        // currentlyIgnored: from db/file response → local.ignored
        //
        // Resolves to { ok: true } or { ok: false, ambiguous: '<pattern>' }.
        function togglePath(folderId, path, currentlyIgnored) {
            path = norm(path);

            return getPatterns(folderId).then(function (patterns) {
                var i, p, idx, updated;

                if (currentlyIgnored) {
                    // User wants to START syncing this path.

                    // 1. Literal ignore entry for exactly this path → remove it.
                    idx = -1;
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] !== '!' && withSlash(p) === path) {
                            idx = i; break;
                        }
                    }
                    if (idx !== -1) {
                        updated = patterns.slice();
                        updated.splice(idx, 1);
                        return setPatterns(folderId, updated).then(ok);
                    }

                    // 2. Catch-all '*' exists → insert whitelist entry before it.
                    idx = patterns.indexOf('*');
                    if (idx !== -1) {
                        updated = patterns.slice();
                        updated.splice(idx, 0, '!' + path);
                        return setPatterns(folderId, updated).then(ok);
                    }

                    // 3. Can't determine — surface the non-literal culprit.
                    return { ok: false, ambiguous: findCulprit(patterns) };

                } else {
                    // User wants to STOP syncing this path.

                    // 1. Whitelist entry '!/path' covers it → remove it.
                    idx = -1;
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] === '!' && withSlash(p) === path) {
                            idx = i; break;
                        }
                    }
                    if (idx !== -1) {
                        updated = patterns.slice();
                        updated.splice(idx, 1);
                        return setPatterns(folderId, updated).then(ok);
                    }

                    // 2. Already has a literal ignore for this path → no-op.
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] !== '!' && withSlash(p) === path) {
                            return ok();
                        }
                    }

                    // 3. No existing pattern → append a literal ignore entry.
                    updated = patterns.slice();
                    updated.push(path);
                    return setPatterns(folderId, updated).then(ok);
                }
            });
        }

        function ok() { return { ok: true }; }

        // Return the first non-literal pattern — likely what's controlling the
        // path — so we can show it to the user in the ambiguity notice.
        function findCulprit(patterns) {
            for (var i = 0; i < patterns.length; i++) {
                if (!isLiteral(patterns[i]) && patterns[i] !== '*') {
                    return patterns[i];
                }
            }
            return '(unknown pattern)';
        }

        return {
            getPatterns: getPatterns,
            setPatterns: setPatterns,
            togglePath: togglePath
        };
    }]);
