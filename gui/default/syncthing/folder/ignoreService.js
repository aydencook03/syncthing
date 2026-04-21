// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

// ignoreService: read/write .stignore via the REST API.
//
// This service is stateless — every operation reads current patterns fresh,
// mutates in memory, and writes back. All path arguments use a leading slash.
//
// Selective sync model:
//   A directory has "selective sync" (SS) on when a `path/*` pattern (or bare
//   `*` for root) blocks its contents by default. Individual items are then
//   opted in via `!` whitelist entries. Toggling SS off removes the catch-all
//   and cleans up all child whitelists/catch-alls under it.

angular.module('syncthing.core')
    .factory('ignoreService', ['$http', function ($http) {
        'use strict';

        // A pattern is "literal" if it's a plain path (no glob chars, no #include,
        // no comment). We only auto-mutate literal patterns; complex patterns are
        // surfaced to the user as ambiguous.
        function isLiteral(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            return p[0] !== '#' && !/[*?\[{]/.test(p);
        }

        // Normalise a path to always have a leading slash.
        function norm(path) {
            return (path[0] === '/') ? path : '/' + path;
        }

        // Strip negation prefix and leading slash from a pattern so it can be
        // compared against a normalised path on equal footing.
        function withSlash(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            return (p[0] === '/') ? p : '/' + p;
        }

        // Returns the parent directory of a normalised path.
        // '/photos/vacation.jpg' → '/photos'
        // '/photos'             → '/'
        function parentDir(path) {
            var idx = path.lastIndexOf('/');
            return (idx === 0) ? '/' : path.slice(0, idx);
        }

        // Returns the catch-all pattern that blocks everything directly inside
        // the same directory as `path`.
        //   '/vacation.jpg'        → '*'       (root catch-all)
        //   '/photos/vacation.jpg' → 'photos/*'
        //   '/photos/2024/img.jpg' → 'photos/2024/*'
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

        // Returns true if selective sync is enabled for a directory, i.e. the
        // pattern `path/*` (or bare `*` for root) is present.
        // path = '/photos' → looks for 'photos/*'
        // path = '/'       → looks for '*'
        function hasDirSelectiveSync(folderId, path) {
            path = norm(path);
            // Append a dummy child so catchAllFor gives us the catch-all *for* path,
            // not for path's parent.
            var catchAll = catchAllFor(path + '/x');
            return getPatterns(folderId).then(function (patterns) {
                return patterns.indexOf(catchAll) !== -1;
            });
        }

        // Toggle selective sync for a directory. Resolves to { ok: true }.
        //
        // enableSS=true:  add `path/*`; if parent has a catch-all, also insert
        //                 `!path` before it so the directory stays traversable.
        // enableSS=false: remove `path/*` and ALL patterns under path/ (child
        //                 whitelists and nested catch-alls become stale without
        //                 their governing catch-all); then manage the `!path`
        //                 whitelist based on whether the parent has a catch-all.
        //
        // Root special case (path='/'): only adds/removes bare `*`; there is no
        // parent to manage.
        function toggleDirSelectiveSync(folderId, path, enableSS) {
            path = norm(path);
            var isRoot     = (path === '/');
            var dirCatchAll    = catchAllFor(path + '/x'); // 'photos/*' or '*'
            var parentCatchAll = isRoot ? null : catchAllFor(path);  // '*' or 'parent/*'
            var whitelist      = '!' + path;                         // '!/photos'

            return getPatterns(folderId).then(function (patterns) {
                var updated = patterns.slice();
                var parentIdx;

                if (enableSS) {
                    // Add path/* if not already present.
                    if (updated.indexOf(dirCatchAll) === -1) {
                        updated.push(dirCatchAll);
                    }
                    // If parent has a catch-all, ensure !path exists before it
                    // so the directory itself remains traversable.
                    if (!isRoot) {
                        parentIdx = updated.indexOf(parentCatchAll);
                        if (parentIdx !== -1 && updated.indexOf(whitelist) === -1) {
                            updated.splice(parentIdx, 0, whitelist);
                        }
                    }
                } else {
                    // Remove path/* and all child patterns under path/.
                    // Child whitelists (!/path/x) and nested catch-alls (path/sub/*)
                    // are only meaningful paired with path/* — without it they're stale.
                    updated = updated.filter(function (pat) {
                        var bare = (pat[0] === '!') ? pat.slice(1) : pat;
                        if (bare[0] === '/') { bare = bare.slice(1); }
                        if (isRoot) {
                            // For root: remove the catch-all (*) and any direct-child
                            // whitelists (!/item, no slash in bare path after stripping).
                            if (bare === dirCatchAll) { return false; }
                            if (pat[0] === '!' && bare.indexOf('/') === -1) { return false; }
                            return true;
                        }
                        var prefix = path.slice(1) + '/'; // e.g. 'photos/'
                        return bare !== dirCatchAll && bare.indexOf(prefix) !== 0;
                    });

                    if (!isRoot) {
                        parentIdx = updated.indexOf(parentCatchAll);
                        if (parentIdx !== -1) {
                            // Parent has catch-all: ensure !path exists so directory
                            // remains accessible and synced.
                            if (updated.indexOf(whitelist) === -1) {
                                updated.splice(parentIdx, 0, whitelist);
                            }
                        } else {
                            // Parent has no catch-all: remove stale !path if present.
                            var wi = updated.indexOf(whitelist);
                            if (wi !== -1) { updated.splice(wi, 1); }
                        }
                    }
                }

                return setPatterns(folderId, updated).then(ok);
            });
        }

        // Toggle sync for a file path.
        //
        // currentlyIgnored: from db/file response (local.ignored).
        //
        // START syncing (currentlyIgnored=true):
        //   1. Remove a literal ignore entry for exactly this path, or
        //   2. Insert a `!path` whitelist before the direct-parent catch-all, or
        //   3. Surface ambiguity — a non-literal pattern is controlling this path.
        //
        // STOP syncing (currentlyIgnored=false):
        //   1. Remove a `!path` whitelist entry that was opting it in, or
        //   2. No-op if a literal ignore already exists, or
        //   3. Append a literal ignore entry.
        //
        // Resolves to { ok: true } or { ok: false, ambiguous: '<pattern>' }.
        function togglePath(folderId, path, currentlyIgnored) {
            path = norm(path);

            return getPatterns(folderId).then(function (patterns) {
                var i, p, idx, updated;

                if (currentlyIgnored) {
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

                    // 2. Direct-parent catch-all (*  or parent/*) exists → whitelist.
                    var ca = catchAllFor(path);
                    idx = patterns.indexOf(ca);
                    if (idx !== -1) {
                        updated = patterns.slice();
                        updated.splice(idx, 0, '!' + path);
                        return setPatterns(folderId, updated).then(ok);
                    }

                    // 3. Can't determine — surface the culprit pattern.
                    return { ok: false, ambiguous: findCulprit(patterns) };

                } else {
                    // 1. Whitelist entry '!/path' → remove it.
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

                    // 2. Literal ignore already exists → no-op.
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

        // Return the first non-literal pattern in the list — likely what's
        // controlling a path we couldn't handle automatically.
        function findCulprit(patterns) {
            for (var i = 0; i < patterns.length; i++) {
                if (!isLiteral(patterns[i])) {
                    return patterns[i];
                }
            }
            return '(unknown pattern)';
        }

        return {
            getPatterns:            getPatterns,
            setPatterns:            setPatterns,
            hasDirSelectiveSync:    hasDirSelectiveSync,
            toggleDirSelectiveSync: toggleDirSelectiveSync,
            togglePath:             togglePath
        };
    }]);
