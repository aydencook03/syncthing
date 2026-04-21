// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

// fileBrowser directive: browse a folder's global file tree and toggle sync
// per item via ignoreService. Opens as a Bootstrap modal.
//
// Usage: $scope.$broadcast('openFileBrowser', { folderId: '...', folderName: '...' })

angular.module('syncthing.core')
    .directive('fileBrowser', ['ignoreService', '$http', '$timeout', function (ignoreService, $http, $timeout) {
        'use strict';

        return {
            restrict: 'E',
            scope: true,
            templateUrl: 'syncthing/folder/fileBrowserView.html',
            link: function (scope) {
                var tree = null;
                var cache = {};
                var pendingTimeouts = [];

                scope.folderId   = null;
                scope.folderName = null;
                scope.loading    = false;
                scope.error      = null;
                scope.empty      = false;
                scope.ambiguous  = null;
                scope.syncAllByDefault = false;

                function cancelPendingTimeouts() {
                    pendingTimeouts.forEach(function (h) { $timeout.cancel(h); });
                    pendingTimeouts = [];
                }

                // Listen for open requests from anywhere in the app.
                scope.$on('openFileBrowser', function (evt, data) {
                    scope.folderId   = data.folderId;
                    scope.folderName = data.folderName || data.folderId;
                    scope.ambiguous  = null;
                    cancelPendingTimeouts();
                    if (tree) { try { tree.destroy(); } catch(e) {} tree = null; }
                    cache = {};
                    $('#fileBrowserModal').modal('show');
                    scope.load();
                });

                scope.$on('$destroy', function () {
                    cancelPendingTimeouts();
                    if (tree) { try { tree.destroy(); } catch(e) {} tree = null; }
                });

                scope.toggleRootSS = function () {
                    // syncAllByDefault is already flipped by ng-model before this fires.
                    // checked (true)  = everything syncs = SS off (enableSS=false)
                    // unchecked (false) = not all syncs  = SS on  (enableSS=true)
                    var intended = scope.syncAllByDefault;
                    var enableSS = !intended;
                    ignoreService.toggleDirSelectiveSync(scope.folderId, '/', enableSS)
                        .then(function (result) {
                            if (!result.ok) {
                                scope.syncAllByDefault = !intended;
                            } else {
                                // Refresh all rendered top-level nodes — root SS change
                                // affects the effective state of every child.
                                var h = $timeout(function () {
                                    if (!tree) return;
                                    tree.getRootNode().visit(function (child) {
                                        child.data.statusLoaded = false;
                                        refreshNodeStatus(child);
                                    });
                                }, 800);
                                pendingTimeouts.push(h);
                            }
                        });
                };

                scope.load = function () {
                    scope.loading = true;
                    scope.error   = null;
                    scope.empty   = false;

                    ignoreService.hasDirSelectiveSync(scope.folderId, '/').then(function (hasSS) {
                        scope.syncAllByDefault = !hasSS;
                    });

                    $http.get(urlbase + '/db/browse?folder=' + encodeURIComponent(scope.folderId) + '&levels=1')
                        .then(function (r) {
                            scope.loading = false;
                            var items = r.data || [];
                            cache[''] = items;
                            if (items.length === 0) { scope.empty = true; return; }
                            // Defer mountTree one tick so ng-if has time to render the container div.
                            $timeout(function () { mountTree(toNodes(items, '')); });
                        }, function (err) {
                            scope.loading = false;
                            scope.error = 'Failed to load file tree (' + (err.status || 'network error') + ').';
                        });
                };

                // Convert db/browse items to FancyTree node definitions.
                // Checkbox state starts false; real state loaded async via db/file.
                function toNodes(items, parentPath) {
                    return items.map(function (item) {
                        var path = parentPath + '/' + item.name;
                        var isDir = item.type === 'FILE_INFO_TYPE_DIRECTORY';
                        return {
                            title: nodeTitle(item.name, item.size),
                            key: path,
                            folder: isDir,
                            lazy: isDir,
                            selected: false,
                            checkbox: true,
                            data: { statusLoaded: false }
                        };
                    });
                }

                function nodeTitle(name, size) {
                    var s = size ? ' <small class="text-muted">(' + humanSize(size) + ')</small>' : '';
                    return '<span>' + escHtml(name) + s + '</span>';
                }

                function mountTree(nodes) {
                    var el = document.getElementById('file-browser-tree-' + scope.folderId);
                    if (!el) return;

                    $(el).fancytree({
                        extensions: ['glyph'],
                        checkbox: true,
                        selectMode: 2,          // independent checkboxes — state comes from db/file per node
                        clickFolderMode: 4,     // click title → expand; click checkbox → select
                        autoActivate: false,
                        escapeTitles: false,    // titles contain safe HTML (size badge)
                        glyph: { preset: 'awesome5' },
                        source: nodes,

                        // Lazy-load children when a folder is expanded.
                        // FancyTree requires data.result to be an array or jQuery Deferred — not an Angular promise.
                        lazyLoad: function (event, data) {
                            var path = data.node.key;
                            if (cache[path]) {
                                data.result = toNodes(cache[path], path);
                                return;
                            }
                            var def = $.Deferred();
                            var stripped = path.replace(/^\/+/, '');
                            $http.get(
                                urlbase + '/db/browse?folder=' + encodeURIComponent(scope.folderId) +
                                '&levels=1&prefix=' + encodeURIComponent(stripped)
                            ).then(function (r) {
                                cache[path] = r.data || [];
                                def.resolve(toNodes(cache[path], path));
                            }, function () {
                                def.reject();
                            });
                            data.result = def.promise();
                        },

                        // After children are inserted into the tree, fetch their ignore status.
                        loadChildren: function (event, data) {
                            loadStatusForNodes(data.node.children || []);
                        },

                        // User toggled a checkbox.
                        select: function (event, data) {
                            var node = data.node;
                            scope.ambiguous = null;

                            var promise;
                            if (node.folder) {
                                // checked   (node.selected=true)  → everything syncs  → enableSS=false
                                // unchecked (node.selected=false) → not all syncs     → enableSS=true
                                var enableSS = !node.selected;
                                promise = ignoreService.toggleDirSelectiveSync(scope.folderId, node.key, enableSS);
                            } else {
                                // For files: checkbox = syncing.
                                // selected=true  → was ignored → user wants to START syncing
                                // selected=false → was syncing → user wants to STOP  syncing
                                var wasIgnored = node.selected;
                                promise = ignoreService.togglePath(scope.folderId, node.key, wasIgnored);
                            }

                            promise.then(function (result) {
                                if (!result.ok) {
                                    // Revert to prior state and surface the ambiguity notice.
                                    node.setSelected(!node.selected, { noEvents: true });
                                    scope.$apply(function () { scope.ambiguous = result.ambiguous; });
                                } else {
                                    // Syncthing re-evaluates ignores after a write; refresh after
                                    // a short settle delay. For directories, also refresh all
                                    // rendered descendants since their effective state may have changed.
                                    var h = $timeout(function () {
                                        refreshNodeStatus(node);
                                        if (node.folder) {
                                            node.visit(function (child) {
                                                child.data.statusLoaded = false;
                                                refreshNodeStatus(child);
                                            });
                                        }
                                    }, 800);
                                    pendingTimeouts.push(h);
                                }
                            });
                        },

                        // Click on folder title → expand/collapse.
                        click: function (event, data) {
                            if (data.targetType === 'title' && data.node.isFolder()) {
                                data.node.toggleExpanded();
                                return false;
                            }
                        }
                    });

                    tree = $.ui.fancytree.getTree(el);
                    loadStatusForNodes(tree.getRootNode().children || []);
                }

                function loadStatusForNodes(nodes) {
                    (nodes || []).forEach(function (node) {
                        if (!node || node.data.statusLoaded) return;
                        refreshNodeStatus(node);
                    });
                }

                function refreshNodeStatus(node) {
                    if (!node || !node.key || !tree) return;

                    if (node.folder) {
                        // A directory is SS-on (unchecked) if Syncthing considers it
                        // ignored (blocked by an ancestor catch-all) OR if it has its
                        // own dir/* pattern. Both signals are needed: local.ignored
                        // catches ancestor-inherited blocking; dir/* catches explicit SS.
                        var dirPath = node.key.replace(/^\/+/, '');
                        $http.get(
                            urlbase + '/db/file?folder=' + encodeURIComponent(scope.folderId) +
                            '&file=' + encodeURIComponent(dirPath)
                        ).then(function (r) {
                            if (!tree) return;
                            var ignoredByAncestor = r.data && r.data.local && r.data.local.ignored;
                            if (ignoredByAncestor) {
                                node.setSelected(false, { noEvents: true });
                                node.data.statusLoaded = true;
                            } else {
                                ignoreService.hasDirSelectiveSync(scope.folderId, node.key)
                                    .then(function (hasSS) {
                                        if (!tree) return;
                                        node.setSelected(!hasSS, { noEvents: true });
                                        node.data.statusLoaded = true;
                                    });
                            }
                        }, function () {
                            // Not in local index yet — check patterns only.
                            ignoreService.hasDirSelectiveSync(scope.folderId, node.key)
                                .then(function (hasSS) {
                                    if (!tree) return;
                                    node.setSelected(!hasSS, { noEvents: true });
                                    node.data.statusLoaded = true;
                                });
                        });
                    } else {
                        var path = node.key.replace(/^\/+/, ''); // db/file wants no leading slash
                        $http.get(
                            urlbase + '/db/file?folder=' + encodeURIComponent(scope.folderId) +
                            '&file=' + encodeURIComponent(path)
                        ).then(function (r) {
                            if (!tree) return;
                            var ignored = r.data && r.data.local && r.data.local.ignored;
                            node.setSelected(!ignored, { noEvents: true });
                            node.data.statusLoaded = true;
                        }, function () {
                            // Not in local index yet — leave unchecked.
                            node.data.statusLoaded = true;
                        });
                    }
                }

                scope.openIgnorePatterns = function () {
                    $('#fileBrowserModal').modal('hide');
                    scope.$emit('openIgnorePatternsFor', { folderId: scope.folderId });
                };

                function humanSize(bytes) {
                    if (!bytes) return '0 B';
                    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
                    var i = Math.floor(Math.log(bytes) / Math.log(1024));
                    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
                }

                function escHtml(s) {
                    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                }
            }
        };
    }]);
