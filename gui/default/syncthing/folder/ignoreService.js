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
            return p[0] !== '#' && !/[*?\\[{]/.test(p);
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

        // Returns the parent directory of a normalised path (with leading slash).
        // '/photos/vacation.jpg' → '/photos'
        // '/photos'             → '/'
        function parentDir(path) {
            var idx = path.lastIndexOf('/');
            return (idx === 0) ? '/' : path.slice(0, idx);
        }

        // The catch-all wildcard pattern that directly covers a given path.
        // This is the pattern whose presence means "everything in path's parent dir
        // is ignored by default".
        //   '/vacation.jpg'         → '*'
        //   '/photos/vacation.jpg'  → 'photos/*'
        //   '/photos/2024/img.jpg'  → 'photos/2024/*'
        function catchAllFor(path) {
            var parent = parentDir(path);
            return (parent === '/') ? '*' : parent.slice(1) + '/*';
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

        // Is selective sync enabled for a directory?
        // i.e. does `path/*` (without leading slash) exist in patterns?
        // Resolves to true/false.
        function hasDirSelectiveSync(folderId, path) {
            path = norm(path);
            var catchAll = catchAllFor(path + '/x'); // catch-all for direct children
            return getPatterns(folderId).then(function (patterns) {
                return patterns.indexOf(catchAll) !== -1;
            });
        }

        // Toggle selective sync for a directory.
        //
        // enableSS=true:  add `path/*`, and if parent has a catch-all, add `!path`
        //                 before it so the directory itself is traversable.
        // enableSS=false: remove `path/*`; if parent has a catch-all, keep/add `!path`
        //                 so directory remains accessible; if parent has no catch-all,
        //                 remove any stale `!path` entry.
        //
        // Resolves to { ok: true } or { ok: false, ambiguous: '<pattern>' }.
        function toggleDirSelectiveSync(folderId, path, enableSS) {
            path = norm(path);
            var dirCatchAll   = catchAllFor(path + '/x'); // e.g. 'photos/*'
            var parentCatchAll = catchAllFor(path);        // e.g. '*' or 'parent/*'
            var whitelist     = '!' + path;               // e.g. '!/photos'

            return getPatterns(folderId).then(function (patterns) {
                var updated = patterns.slice();
                var dirIdx, whiteIdx, parentIdx;

                // Find relevant indices.
                dirIdx    = updated.indexOf(dirCatchAll);
                whiteIdx  = updated.indexOf(whitelist);
                parentIdx = updated.indexOf(parentCatchAll);

                if (enableSS) {
                    // Add path/* if not already present.
                    if (dirIdx === -1) {
                        updated.push(dirCatchAll);
                    }
                    // If parent has a catch-all, ensure !path whitelist exists before it
                    // so the directory itself is traversable.
                    if (parentIdx !== -1 && whiteIdx === -1) {
                        updated.splice(parentIdx, 0, whitelist);
                    }
                } else {
                    // Remove path/*.
                    if (dirIdx !== -1) {
                        updated.splice(dirIdx, 1);
                    }
                    // Re-read parentIdx after potential splice.
                    parentIdx = updated.indexOf(parentCatchAll);

                    if (parentIdx !== -1) {
                        // Parent has catch-all: ensure !path whitelist exists so directory
                        // remains visible/synced.
                        if (updated.indexOf(whitelist) === -1) {
                            updated.splice(parentIdx, 0, whitelist);
                        }
                    } else {
                        // Parent has no catch-all: remove stale !path if present.
                        var wi = updated.indexOf(whitelist);
                        if (wi !== -1) { updated.splice(wi, 1); }
                    }
                }

                return setPatterns(folderId, updated).then(ok);
            });
        }

        // Toggle sync for a file path.
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

                    // 2. Direct-parent catch-all exists → insert whitelist entry before it.
                    var ca = catchAllFor(path);
                    idx = patterns.indexOf(ca);
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
                if (!isLiteral(patterns[i])) {
                    return patterns[i];
                }
            }
            return '(unknown pattern)';
        }

        return {
            getPatterns:           getPatterns,
            setPatterns:           setPatterns,
            hasDirSelectiveSync:   hasDirSelectiveSync,
            toggleDirSelectiveSync: toggleDirSelectiveSync,
            togglePath:            togglePath
        };
    }]);
