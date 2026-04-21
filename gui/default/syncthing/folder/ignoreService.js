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
//     If a `!/file` whitelist exists, remove it (re-exposes file to catch-all).
//     If a literal ignore entry exists, no-op.
//     Otherwise: walk UP disabling SBD on each SBD ancestor until we hit a
//     not-SBD ancestor or root. File is then blocked by the nearest catch-all.
//
//   ✗→✓  file  (start syncing):
//     If a literal ignore entry exists, remove it.
//     If any ancestor catch-all exists, insert `!/file` before the nearest one.
//     Otherwise: ambiguous (non-literal pattern in control) — surface to user.
//
//   ✓→✗  dir   (disable SBD):
//     Clean up child patterns first (they become stale under the new catch-all).
//     Add `dir/*`. If parent is not-SBD, insert `!/dir` before its catch-all
//     so this dir stays traversable.
//
//   ✗→✓  dir   (enable SBD):
//     Remove `dir/*` and all patterns under `dir/` (stale without the
//     catch-all). Keep/add `!/dir` if parent is not-SBD (so the dir
//     remains visible); remove it if parent is SBD.
//
// ─── Escaping ────────────────────────────────────────────────────────────────
//
//   Syncthing treats *, ?, [, ], {, }, \ as glob metacharacters in patterns.
//   Any of these appearing in an actual file/directory name must be escaped
//   with a backslash when embedded in a pattern (e.g. `[Work]` → `\[Work\]`).
//   All pattern-construction helpers (catchAllFor, wlFor) escape their inputs.
//   bareOf() unescapes when stripping so that all internal comparisons operate
//   on plain unescaped paths.
//
// ─────────────────────────────────────────────────────────────────────────────

angular.module('syncthing.core')
    .factory('ignoreService', ['$http', function ($http) {
        'use strict';

        // Escape glob-special characters in a path so it is treated as a
        // literal when embedded in an .stignore pattern.
        function escapePath(path) {
            return path.replace(/([\\*?\[\]{}])/g, '\\$1');
        }

        // Unescape a path extracted from a pattern (reverse of escapePath).
        function unescapePath(path) {
            return path.replace(/\\([\\*?\[\]{}])/g, '$1');
        }

        // A pattern is "literal" if it has no unescaped glob chars and is not
        // a comment or #include. We only auto-mutate literal patterns; anything
        // else surfaces as ambiguous.
        function isLiteral(pattern) {
            var p = (pattern[0] === '!') ? pattern.slice(1) : pattern;
            if (p[0] === '#') { return false; }
            // Walk the string; a backslash escapes the next char (not a glob)
            for (var i = 0; i < p.length; i++) {
                if (p[i] === '\\') { i++; continue; }
                if (/[*?\[{]/.test(p[i])) { return false; }
            }
            return true;
        }

        // Normalise a path to always have a leading slash.
        function norm(path) {
            return (path[0] === '/') ? path : '/' + path;
        }

        // Parent directory of a normalised path.
        // '/photos/img.jpg' → '/photos',  '/photos' → '/'
        function parentDir(path) {
            var idx = path.lastIndexOf('/');
            return (idx === 0) ? '/' : path.slice(0, idx);
        }

        // Catch-all pattern governing `path` (blocks everything in path's parent dir).
        // Paths are plain (unescaped); the returned pattern is escaped.
        //   '/img.jpg'        → '*'
        //   '/photos/img.jpg' → 'photos/*'       (assuming 'photos' has no special chars)
        //   '/[Work]/f.txt'   → '\[Work\]/*'
        function catchAllFor(path) {
            var parent = parentDir(path);
            return (parent === '/') ? '*' : escapePath(parent.slice(1)) + '/*';
        }

        // Catch-all pattern for the contents of a directory (disables SBD for that dir).
        //   '/'       → '*'
        //   '/photos' → 'photos/*'
        function catchAllIn(dir) {
            return catchAllFor(dir + '/x');
        }

        // Whitelist pattern for a path (allows it through an ancestor catch-all).
        // '/photos'           → '!/photos'
        // '/[Work]'           → '!/\[Work\]'
        // '/[Work]/vacation'  → '!/\[Work\]/vacation'
        function wlFor(path) {
            // path is normalised ('/foo/bar'). Strip leading slash, escape each
            // segment individually, then re-add '!/' prefix.
            var segments = path.slice(1).split('/');
            return '!/' + segments.map(escapePath).join('/');
        }

        // Strip negation prefix, leading slash, and glob escapes from a pattern
        // to get a plain comparable path (no leading slash).
        // '!/\[Work\]/*'  → '[Work]/*'   (note: we only unescape, not strip /*)
        // '!/photos'      → 'photos'
        // 'photos/*'      → 'photos/*'
        function bareOf(pat) {
            var p = (pat[0] === '!') ? pat.slice(1) : pat;
            p = (p[0] === '/') ? p.slice(1) : p;
            return unescapePath(p);
        }

        // Convert a stored pattern back to a plain normalised path (with leading slash).
        // Used to compare stored patterns against path arguments.
        // '!/\[Work\]' → '/[Work]'
        // 'photos'     → '/photos'
        function patternToPath(pat) {
            return '/' + bareOf(pat);
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

        // True if `dir` is SBD: no own catch-all, and no ancestor catch-all governs it.
        // Pure pattern read — no lag.
        function dirSyncsAllByDefault(folderId, dir) {
            dir = norm(dir);
            return getPatterns(folderId).then(function (patterns) {
                return patterns.indexOf(catchAllIn(dir)) === -1 && !isAncestorBlocked(dir, patterns);
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
                var wl = wlFor(dir);
                if (parentIdx !== -1 && updated.indexOf(wl) === -1) {
                    updated.splice(parentIdx, 0, wl);
                }
                dir = parentDir(dir);
            }
        }

        // True if `path` is blocked by an ancestor catch-all in `patterns`
        // (i.e. some ancestor has a catch-all and `path` has no whitelist before it).
        function isAncestorBlocked(path, patterns) {
            var cur = norm(path);
            while (cur !== '/') {
                var ca    = catchAllFor(cur);
                var caIdx = patterns.indexOf(ca);
                if (caIdx !== -1) {
                    var wl    = wlFor(cur);
                    var wlIdx = patterns.indexOf(wl);
                    if (wlIdx === -1 || wlIdx > caIdx) { return true; }
                }
                cur = parentDir(cur);
            }
            return false;
        }

        // Set SBD state for a directory. sbd=true → enable SBD (remove catch-all).
        //                                sbd=false → disable SBD (add catch-all).
        // Resolves to { ok: true }.
        function setDirSBD(folderId, path, sbd) {
            path = norm(path);
            var isRoot   = (path === '/');
            var ca       = catchAllIn(path);
            var bareCa   = bareOf(ca);          // unescaped, for filter comparisons
            var parentCa = isRoot ? null : catchAllFor(path);
            var wl       = wlFor(path);
            var prefix   = path.slice(1) + '/'; // e.g. 'photos/' — unused for root; unescaped

            return getPatterns(folderId).then(function (patterns) {
                var updated = patterns.slice();
                var parentIdx;

                if (!sbd) {
                    // Disable SBD: remove own whitelist and all child patterns.
                    updated = updated.filter(function (pat) {
                        var bare = bareOf(pat);
                        if (isRoot) {
                            if (pat[0] === '!' && bare.indexOf('/') === -1) { return false; } // !/child
                            if (bare.indexOf('/') !== -1) { return false; }                   // sub-paths
                            return true;
                        }
                        return pat !== wl && bare.indexOf(prefix) !== 0;
                    });
                    // Only add dir/* if no ancestor catch-all already governs this dir.
                    // (If one does, removing the whitelist is enough — dir is already blocked.)
                    if (!isAncestorBlocked(path, updated)) {
                        if (updated.indexOf(ca) === -1) { updated.push(ca); }
                    }
                } else {
                    // Enable SBD: remove catch-all and all child patterns.
                    // Child whitelists and nested catch-alls are stale without their governing catch-all.
                    updated = updated.filter(function (pat) {
                        var bare = bareOf(pat);
                        if (isRoot) {
                            if (bare === '*') { return false; }              // root catch-all
                            if (bare.indexOf('/') !== -1) { return false; } // child catch-alls + nested sub-paths
                            if (pat[0] === '!') { return false; }           // remaining whitelists (e.g. !/child)
                            return true;                                     // keep: literal root-level file ignores
                        }
                        return bare !== bareCa && bare.indexOf(prefix) !== 0;
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

        // Toggle sync for a file. `nowSelected` is the new checkbox state:
        // true = user just checked it (file was ignored, start syncing).
        // false = user just unchecked it (file was syncing, stop syncing).
        // Resolves to { ok: true } or { ok: false, ambiguous }.
        function togglePath(folderId, path, nowSelected) {
            path = norm(path);
            return getPatterns(folderId).then(function (patterns) {
                var i, p, idx, updated;

                if (nowSelected) {
                    // ✗→✓  start syncing (file was ignored, user checked it).
                    // 1. Literal ignore entry → remove it.
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] !== '!' && patternToPath(p) === path) {
                            updated = patterns.slice();
                            updated.splice(i, 1);
                            return setPatterns(folderId, updated).then(ok);
                        }
                    }
                    // 2. Find the nearest ancestor catch-all and insert !/file before it.
                    idx = nearestAncestorCatchAll(path, patterns);
                    if (idx !== -1) {
                        updated = patterns.slice();
                        updated.splice(idx, 0, wlFor(path));
                        return setPatterns(folderId, updated).then(ok);
                    }
                    // 3. Can't determine — surface the culprit.
                    return { ok: false, ambiguous: findCulprit(patterns) };

                } else {
                    // ✓→✗  stop syncing (file was syncing, user unchecked it).
                    // 1. !/file whitelist → remove it (re-exposes to parent catch-all).
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] === '!' && patternToPath(p) === path) {
                            updated = patterns.slice();
                            updated.splice(i, 1);
                            return setPatterns(folderId, updated).then(ok);
                        }
                    }
                    // 2. Literal ignore already exists → no-op.
                    for (i = 0; i < patterns.length; i++) {
                        p = patterns[i];
                        if (isLiteral(p) && p[0] !== '!' && patternToPath(p) === path) {
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

        // Index of the nearest ancestor catch-all pattern in `patterns` for `path`.
        // Walks from direct parent upward; returns -1 if none found.
        function nearestAncestorCatchAll(path, patterns) {
            var cur = norm(path);
            while (cur !== '/') {
                var ca  = catchAllFor(cur);
                var idx = patterns.indexOf(ca);
                if (idx !== -1) { return idx; }
                cur = parentDir(cur);
            }
            return -1;
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
