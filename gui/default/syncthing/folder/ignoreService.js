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
// ─── State machine ───────────────────────────────────────────────────────────
//
//   Every item has exactly two checkbox states:
//     File:      ✓ syncs          | ✗ ignored
//     Directory: ✓ everything in this directory syncs by default
//                ✗ not everything in this directory syncs by default
//
//   Ignore-file representation:
//     Dir not-all-default ↔  pattern `dir/*` present  (bare `*` for root)
//     File ignored        ↔  literal `/file` entry, OR covered by ancestor `dir/*`
//     Item whitelisted    ↔  `!/item` before the governing `dir/*`
//
//   Transition rules:
//
//   ✓→✗  file   (stop syncing):
//     Walk UP from the file's parent. For every ancestor directory that does
//     not yet have a catch-all, add `dir/*` to it. Insert `!/dir` before
//     the grandparent's catch-all if needed so the dir stays traversable.
//     Stop when an ancestor already has a catch-all or we reach root.
//     The file is then automatically blocked by its nearest ancestor's catch-all.
//
//   ✗→✓  file   (start syncing):
//     The file must be covered by the direct-parent catch-all (invariant).
//     Insert `!/file` before that catch-all.  No ancestor walk needed.
//
//   ✓→✗  dir    (not everything syncs → mark directory):
//     Clean up any child patterns first (orphaned whitelists / nested
//     catch-alls become stale).  Add `dir/*`.  If parent has a catch-all,
//     insert `!/dir` before it so the directory stays traversable.
//     No ancestor walk needed — ancestors still sync by default and the
//     dir remains accessible within them.
//
//   ✗→✓  dir    (everything syncs → unmark directory):
//     Remove `dir/*` and ALL patterns under `dir/` (child whitelists and
//     nested catch-alls are stale without their governing catch-all).
//     Then manage the `!/dir` whitelist: keep/add it if parent has a
//     catch-all (directory must remain visible), remove it if parent has
//     no catch-all.
//     No upward ancestor walk — the `!/dir` mechanism is enough to keep
//     the directory accessible within any parent catch-all.
//
// ─────────────────────────────────────────────────────────────────────────────

angular.module('syncthing.core')
    .factory('ignoreService', ['$http', function ($http) {
        'use strict';

        // A pattern is "literal" if it contains no glob characters, no #include,
        // and is not a comment. We only auto-mutate literal patterns; anything
        // else is surfaced to the user as ambiguous.
        function isLiteral(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            return p[0] !== '#' && !/[*?\[{]/.test(p);
        }

        // Normalise a path to always have a leading slash.
        function norm(path) {
            return (path[0] === '/') ? path : '/' + path;
        }

        // Strip negation prefix and leading slash from a pattern for comparison
        // against a normalised path.
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

        // The catch-all pattern that blocks everything in the same directory as
        // `path` (i.e. `path`'s parent directory).
        //   '/img.jpg'        → '*'
        //   '/photos/img.jpg' → 'photos/*'
        //   '/photos/24/img'  → 'photos/24/*'
        function catchAllFor(path) {
            var parent = parentDir(path);
            return (parent === '/') ? '*' : parent.slice(1) + '/*';
        }

        // The catch-all pattern that blocks everything *inside* a directory.
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

        // True if `dir` syncs everything by default — i.e. it has no catch-all of its own
        // AND is not governed by an ancestor catch-all (or is whitelisted out of one).
        // This is the single source of truth for directory checkbox state, derived purely
        // from patterns (no db/file call needed, so no Syncthing re-evaluation lag).
        function dirSyncsAllByDefault(folderId, dir) {
            dir = norm(dir);
            var ownCatchAll      = catchAllIn(dir);   // dir/* — blocks contents of dir
            var ancestorCatchAll = catchAllFor(dir);  // parent/* — blocks dir itself
            var whitelist        = '!' + dir;         // !/dir — exempts dir from parent catch-all
            return getPatterns(folderId).then(function (patterns) {
                // Blocked by own catch-all?
                if (patterns.indexOf(ownCatchAll) !== -1) { return false; }
                // Governed by ancestor catch-all and not whitelisted before it?
                var caIdx = patterns.indexOf(ancestorCatchAll);
                if (caIdx !== -1) {
                    var wlIdx = patterns.indexOf(whitelist);
                    if (wlIdx === -1 || wlIdx > caIdx) { return false; }
                }
                return true;
            });
        }

        // Add a catch-all to every ancestor of `path` that does not yet have one,
        // walking up until we hit an ancestor that already has one or we reach root.
        // Mutates `updated` in place. Single write is done by the caller.
        function addCatchAllsUpward(path, updated) {
            var dir = parentDir(norm(path));
            while (true) {
                var ca = catchAllIn(dir);
                if (updated.indexOf(ca) !== -1) { break; } // ancestor already has a catch-all — stop
                updated.push(ca);
                if (dir === '/') { break; } // just processed root — done
                // Insert !/dir before the parent catch-all so this dir stays traversable.
                var parentCa = catchAllIn(parentDir(dir));
                var parentIdx = updated.indexOf(parentCa);
                if (parentIdx !== -1 && updated.indexOf('!' + dir) === -1) {
                    updated.splice(parentIdx, 0, '!' + dir);
                }
                dir = parentDir(dir);
            }
        }

        // Add or remove the catch-all for a directory. Resolves to { ok: true }.
        // addCatchAll=true  → add `dir/*` (not everything syncs by default).
        // addCatchAll=false → remove `dir/*` (everything syncs by default).
        function toggleDirCatchAll(folderId, path, addCatchAll) {
            path = norm(path);
            var isRoot        = (path === '/');
            var dirCatchAll   = catchAllIn(path);
            var parentCatchAll = isRoot ? null : catchAllFor(path);
            var whitelist     = '!' + path;

            return getPatterns(folderId).then(function (patterns) {
                var updated = patterns.slice();
                var parentIdx;

                if (addCatchAll) {
                    // Remove any existing child patterns under dir/ first — they are
                    // now governed by dir/* and would be redundant or contradictory.
                    updated = updated.filter(function (pat) {
                        var bare = (pat[0] === '!') ? pat.slice(1) : pat;
                        if (bare[0] === '/') { bare = bare.slice(1); }
                        if (isRoot) {
                            // Remove all direct-child whitelists (!/item) and any sub-catch-alls.
                            // Keep non-whitelist top-level literals (they become redundant but
                            // removing them could be surprising; user can clean via ignore editor).
                            if (pat[0] === '!' && bare.indexOf('/') === -1) { return false; }
                            if (bare.indexOf('/') !== -1) { return false; } // sub-path of any depth
                            return true;
                        }
                        var ssPrefix = path.slice(1) + '/';
                        return bare.indexOf(ssPrefix) !== 0;
                    });
                    // Add dir/* if not already present.
                    if (updated.indexOf(dirCatchAll) === -1) {
                        updated.push(dirCatchAll);
                    }
                    // If parent has a catch-all, insert !/dir before it so the
                    // directory stays traversable.
                    if (!isRoot) {
                        parentIdx = updated.indexOf(parentCatchAll);
                        if (parentIdx !== -1 && updated.indexOf(whitelist) === -1) {
                            updated.splice(parentIdx, 0, whitelist);
                        }
                    }
                } else {
                    // Remove dir/* and all patterns under dir/.
                    // Child whitelists and nested catch-alls are only meaningful
                    // paired with dir/* — without it they are stale.
                    updated = updated.filter(function (pat) {
                        var bare = (pat[0] === '!') ? pat.slice(1) : pat;
                        if (bare[0] === '/') { bare = bare.slice(1); }
                        if (isRoot) {
                            // Remove * and direct-child whitelists (!/item, no '/' in bare).
                            if (bare === dirCatchAll) { return false; }
                            if (pat[0] === '!' && bare.indexOf('/') === -1) { return false; }
                            return true;
                        }
                        var prefix = path.slice(1) + '/';
                        return bare !== dirCatchAll && bare.indexOf(prefix) !== 0;
                    });

                    if (!isRoot) {
                        parentIdx = updated.indexOf(parentCatchAll);
                        if (parentIdx !== -1) {
                            // Parent has catch-all: keep/add !/dir so directory remains visible.
                            if (updated.indexOf(whitelist) === -1) {
                                updated.splice(parentIdx, 0, whitelist);
                            }
                        } else {
                            // Parent has no catch-all: remove stale !/dir if present.
                            var wi = updated.indexOf(whitelist);
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
                    // ✗→✓ start syncing.

                    // 1. Literal ignore entry → remove it.
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] !== '!' && withSlash(p) === path) {
                            updated = patterns.slice();
                            updated.splice(i, 1);
                            return setPatterns(folderId, updated).then(ok);
                        }
                    }

                    // 2. Direct-parent catch-all exists → insert !/file before it.
                    idx = patterns.indexOf(catchAllFor(path));
                    if (idx !== -1) {
                        updated = patterns.slice();
                        updated.splice(idx, 0, '!' + path);
                        return setPatterns(folderId, updated).then(ok);
                    }

                    // 3. Can't determine — surface the culprit.
                    return { ok: false, ambiguous: findCulprit(patterns) };

                } else {
                    // ✓→✗ stop syncing.

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

                    // 3. No existing pattern → file was syncing freely with no
                    // ancestor catch-all. Walk up and add one to each ancestor
                    // that lacks it. The file is then blocked by the nearest one.
                    updated = patterns.slice();
                    addCatchAllsUpward(path, updated);
                    return setPatterns(folderId, updated).then(ok);
                }
            });
        }

        function ok() { return { ok: true }; }

        // Return the first non-literal pattern — likely what's controlling a
        // path we couldn't handle automatically.
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
            dirSyncsAllByDefault: dirSyncsAllByDefault,
            toggleDirCatchAll: toggleDirCatchAll,
            togglePath:             togglePath
        };
    }]);
