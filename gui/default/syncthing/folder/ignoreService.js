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
// ─── Concepts ────────────────────────────────────────────────────────────────
//
//   SBD (syncs by default): a directory is SBD when everything inside it
//   syncs unless explicitly excluded. The opposite is a "catch-all" pattern
//   (`dir/*`, or bare `*` for root) which blocks everything inside the
//   directory by default, allowing only whitelisted items through (`!/item`).
//
//   File:      ✓ syncs   | ✗ ignored
//   Directory: ✓ SBD     | ✗ not SBD  (has a catch-all, or ancestor does)
//
// ─── State machine ───────────────────────────────────────────────────────────
//
//   ✓→✗  file  (stop syncing):
//     Walk UP from the file's parent. For every ancestor that is SBD, disable
//     SBD (add `dir/*`), inserting `!/dir` before the grandparent catch-all
//     so the dir stays traversable. Stop when an ancestor is already not-SBD
//     or we reach root. The file is then blocked by the nearest catch-all.
//
//   ✗→✓  file  (start syncing):
//     Insert `!/file` before the direct-parent catch-all.
//
//   ✓→✗  dir   (disable SBD):
//     Clean up child patterns first. Add `dir/*`. If parent is not-SBD,
//     insert `!/dir` before its catch-all so this dir stays traversable.
//
//   ✗→✓  dir   (enable SBD):
//     Remove `dir/*` and all patterns under `dir/` (stale without the
//     catch-all). Then: keep/add `!/dir` if parent is not-SBD (so the dir
//     remains visible), remove it if parent is SBD.
//
// ─────────────────────────────────────────────────────────────────────────────

angular.module('syncthing.core')
    .factory('ignoreService', ['$http', function ($http) {
        'use strict';

        // A pattern is "literal" if it has no glob chars, no #include, no comment.
        // We only auto-mutate literal patterns; anything else surfaces as ambiguous.
        function isLiteral(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            return p[0] !== '#' && !/[*?\\[{]/.test(p);
        }

        // Normalise a path to always have a leading slash.
        function norm(path) {
            return (path[0] === '/') ? path : '/' + path;
        }

        // Strip negation prefix and leading slash for comparison against a normalised path.
        function withSlash(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            return (p[0] === '/') ? p : '/' + p;
        }

        // Parent directory of a normalised path.
        // '/photos/img.jpg' → '/photos',  '/photos' → '/'
        function parentDir(path) {
            var idx = path.lastIndexOf('/');
            return (idx === 0) ? '/' : path.slice(0, idx);
        }

        // Catch-all pattern governing `path` (blocks everything in path's parent dir).
        //   '/img.jpg'        → '*'
        //   '/photos/img.jpg' → 'photos/*'
        function catchAllFor(path) {
            var parent = parentDir(path);
            return (parent === '/') ? '*' : parent.slice(1) + '/*';
        }

        // Catch-all pattern for the contents of a directory (disables SBD for that dir).
        //   '/'       → '*'
        //   '/photos' → 'photos/*'
        function catchAllIn(dir) {
            return catchAllFor(dir + '/x');
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

        // True if `dir` is SBD: no own catch-all, and not governed by any
        // ancestor catch-all unless whitelisted out of it. Pure pattern read — no lag.
        function dirSyncsAllByDefault(folderId, dir) {
            dir = norm(dir);
            return getPatterns(folderId).then(function (patterns) {
                // Blocked by own catch-all?
                if (patterns.indexOf(catchAllIn(dir)) !== -1) { return false; }
                // Walk every ancestor: if its catch-all is present and dir is not
                // whitelisted before it, dir is governed by that catch-all.
                var cur = dir;
                while (cur !== '/') {
                    var ca    = catchAllFor(cur);   // catch-all governing cur
                    var caIdx = patterns.indexOf(ca);
                    if (caIdx !== -1) {
                        var wl    = '!' + cur;
                        var wlIdx = patterns.indexOf(wl);
                        if (wlIdx === -1 || wlIdx > caIdx) { return false; }
                    }
                    cur = parentDir(cur);
                }
                return true;
            });
        }

        // Disable SBD on every ancestor of `path` that is currently SBD,
        // walking up until we hit a not-SBD ancestor or reach root.
        // Mutates `updated` in place; caller does the single write.
        function disableSBDUpward(path, updated) {
            var dir = parentDir(norm(path));
            while (true) {
                var ca = catchAllIn(dir);
                if (updated.indexOf(ca) !== -1) { break; } // already not-SBD — stop
                updated.push(ca);
                if (dir === '/') { break; }
                // Insert !/dir before the parent catch-all so this dir stays traversable.
                var parentCa = catchAllIn(parentDir(dir));
                var parentIdx = updated.indexOf(parentCa);
                if (parentIdx !== -1 && updated.indexOf('!' + dir) === -1) {
                    updated.splice(parentIdx, 0, '!' + dir);
                }
                dir = parentDir(dir);
            }
        }

        // Set SBD state for a directory. sbd=true → enable SBD (remove catch-all).
        //                                sbd=false → disable SBD (add catch-all).
        // Resolves to { ok: true }.
        function setDirSBD(folderId, path, sbd) {
            path = norm(path);
            var isRoot     = (path === '/');
            var ca         = catchAllIn(path);
            var parentCa   = isRoot ? null : catchAllFor(path);
            var wl         = '!' + path;

            return getPatterns(folderId).then(function (patterns) {
                var updated = patterns.slice();
                var parentIdx;

                if (!sbd) {
                    // Disable SBD: add catch-all. Clean up child patterns first —
                    // they become redundant or contradictory under the new catch-all.
                    updated = updated.filter(function (pat) {
                        var bare = (pat[0] === '!') ? pat.slice(1) : pat;
                        if (bare[0] === '/') { bare = bare.slice(1); }
                        if (isRoot) {
                            if (pat[0] === '!' && bare.indexOf('/') === -1) { return false; } // !/child
                            if (bare.indexOf('/') !== -1) { return false; }                   // sub-paths
                            return true;
                        }
                        return bare.indexOf(path.slice(1) + '/') !== 0;
                    });
                    if (updated.indexOf(ca) === -1) { updated.push(ca); }
                    if (!isRoot) {
                        parentIdx = updated.indexOf(parentCa);
                        if (parentIdx !== -1 && updated.indexOf(wl) === -1) {
                            updated.splice(parentIdx, 0, wl);
                        }
                    }
                } else {
                    // Enable SBD: remove catch-all and all child patterns
                    // (whitelists and nested catch-alls are stale without their governing catch-all).
                    updated = updated.filter(function (pat) {
                        var bare = (pat[0] === '!') ? pat.slice(1) : pat;
                        if (bare[0] === '/') { bare = bare.slice(1); }
                        if (isRoot) {
                            if (bare === ca) { return false; }                                 // *
                            if (pat[0] === '!' && bare.indexOf('/') === -1) { return false; }  // !/child
                            return true;
                        }
                        return bare !== ca && bare.indexOf(path.slice(1) + '/') !== 0;
                    });
                    if (!isRoot) {
                        parentIdx = updated.indexOf(parentCa);
                        if (parentIdx !== -1) {
                            if (updated.indexOf(wl) === -1) { updated.splice(parentIdx, 0, wl); }
                        } else {
                            var wi = updated.indexOf(wl);
                            if (wi !== -1) { updated.splice(wi, 1); }
                        }
                    }
                }

                return setPatterns(folderId, updated).then(ok);
            });
        }

        // Toggle sync for a file. Resolves to { ok: true } or { ok: false, ambiguous }.
        function togglePath(folderId, path, currentlyIgnored) {
            path = norm(path);
            return getPatterns(folderId).then(function (patterns) {
                var i, p, idx, updated;

                if (currentlyIgnored) {
                    // ✗→✓  start syncing.
                    // 1. Literal ignore entry → remove it.
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] !== '!' && withSlash(p) === path) {
                            updated = patterns.slice();
                            updated.splice(i, 1);
                            return setPatterns(folderId, updated).then(ok);
                        }
                    }
                    // 2. Parent catch-all exists → whitelist the file before it.
                    idx = patterns.indexOf(catchAllFor(path));
                    if (idx !== -1) {
                        updated = patterns.slice();
                        updated.splice(idx, 0, '!' + path);
                        return setPatterns(folderId, updated).then(ok);
                    }
                    // 3. Can't determine — surface the culprit.
                    return { ok: false, ambiguous: findCulprit(patterns) };

                } else {
                    // ✓→✗  stop syncing.
                    // 1. !/file whitelist → remove it (re-exposes to parent catch-all).
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] === '!' && withSlash(p) === path) {
                            updated = patterns.slice();
                            updated.splice(i, 1);
                            return setPatterns(folderId, updated).then(ok);
                        }
                    }
                    // 2. Literal ignore already exists → no-op.
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] !== '!' && withSlash(p) === path) {
                            return ok();
                        }
                    }
                    // 3. No ancestor catch-all — disable SBD upward so the file
                    //    gets blocked by its nearest ancestor's catch-all.
                    updated = patterns.slice();
                    disableSBDUpward(path, updated);
                    return setPatterns(folderId, updated).then(ok);
                }
            });
        }

        function ok() { return { ok: true }; }

        // Return the first non-literal pattern — likely what's controlling a
        // path we couldn't handle automatically.
        function findCulprit(patterns) {
            for (var i = 0; i < patterns.length; i++) {
                if (!isLiteral(patterns[i])) { return patterns[i]; }
            }
            return '(unknown pattern)';
        }

        return {
            getPatterns:          getPatterns,
            setPatterns:          setPatterns,
            dirSyncsAllByDefault: dirSyncsAllByDefault,
            setDirSBD:            setDirSBD,
            togglePath:           togglePath
        };
    }]);
