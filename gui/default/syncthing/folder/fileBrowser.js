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

                scope.folderId        = null;
                scope.folderName      = null;
                scope.loading         = false;
                scope.error           = null;
                scope.empty           = false;
                scope.ambiguous       = null;
                scope.syncAllByDefault = false;

                function cancelPendingTimeouts() {
                    pendingTimeouts.forEach(function (h) { $timeout.cancel(h); });
                    pendingTimeouts = [];
                }

                function refreshRootSBD() {
                    ignoreService.dirSyncsAllByDefault(scope.folderId, '/').then(function (sbd) {
                        scope.syncAllByDefault = sbd;
                    });
                }

                // After any write, refresh status for a node (and its rendered descendants
                // if it's a directory), then re-read the root SBD state.
                function refreshAfterWrite(node) {
                    var h = $timeout(function () {
                        refreshNodeStatus(node);
                        if (node.folder) {
                            node.visit(function (child) {
                                child.data.statusLoaded = false;
                                refreshNodeStatus(child);
                            });
                        }
                        refreshRootSBD();
                    }, 0);
                    pendingTimeouts.push(h);
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

                // Toggle SBD for the root directory.
                scope.toggleRootSBD = function () {
                    // Flip ourselves (no ng-model — avoids ng-if child scope shadowing).
                    scope.syncAllByDefault = !scope.syncAllByDefault;
                    var intended = scope.syncAllByDefault;
                    ignoreService.setDirSBD(scope.folderId, '/', intended)
                        .then(function (result) {
                            if (!result.ok) {
                                scope.syncAllByDefault = !intended; // revert
                            } else {
                                // Refresh all rendered nodes — root SBD change affects every dir.
                                var h = $timeout(function () {
                                    if (!tree) return;
                                    tree.getRootNode().visit(function (child) {
                                        child.data.statusLoaded = false;
                                        refreshNodeStatus(child);
                                    });
                                    refreshRootSBD();
                                }, 0);
                                pendingTimeouts.push(h);
                            }
                        });
                };

                scope.load = function () {
                    scope.loading = true;
                    scope.error   = null;
                    scope.empty   = false;
                    refreshRootSBD();
                    $http.get(urlbase + '/db/browse?folder=' + encodeURIComponent(scope.folderId) + '&levels=1')
                        .then(function (r) {
                            scope.loading = false;
                            var items = r.data || [];
                            cache[''] = items;
                            if (items.length === 0) { scope.empty = true; return; }
                            // Defer one tick so ng-if has time to render the container div.
                            $timeout(function () { mountTree(toNodes(items, '')); });
                        }, function (err) {
                            scope.loading = false;
                            scope.error = 'Failed to load file tree (' + (err.status || 'network error') + ').';
                        });
                };

                function toNodes(items, parentPath) {
                    return items.map(function (item) {
                        var path  = parentPath + '/' + item.name;
                        var isDir = item.type === 'FILE_INFO_TYPE_DIRECTORY';
                        return {
                            title:    nodeTitle(item.name, item.size),
                            key:      path,
                            folder:   isDir,
                            lazy:     isDir,
                            selected: false,
                            checkbox: true,
                            data:     { statusLoaded: false }
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
                        selectMode: 2,          // independent checkboxes — state loaded async per node
                        clickFolderMode: 4,     // click title → expand; click checkbox → select
                        autoActivate: false,
                        escapeTitles: false,    // titles contain safe HTML (size badge)
                        glyph: { preset: 'awesome5' },
                        source: nodes,

                        // Lazy-load children when a folder is expanded.
                        // FancyTree requires data.result to be an array or jQuery Deferred.
                        lazyLoad: function (event, data) {
                            var path = data.node.key;
                            if (cache[path]) { data.result = toNodes(cache[path], path); return; }
                            var def     = $.Deferred();
                            var stripped = path.replace(/^\/+/, '');
                            $http.get(
                                urlbase + '/db/browse?folder=' + encodeURIComponent(scope.folderId) +
                                '&levels=1&prefix=' + encodeURIComponent(stripped)
                            ).then(function (r) {
                                cache[path] = r.data || [];
                                def.resolve(toNodes(cache[path], path));
                            }, function () { def.reject(); });
                            data.result = def.promise();
                        },

                        loadChildren: function (event, data) {
                            (data.node.children || []).forEach(function (node) {
                                if (!node.data.statusLoaded) { refreshNodeStatus(node); }
                            });
                        },

                        select: function (event, data) {
                            var node = data.node;
                            scope.ambiguous = null;
                            var promise = node.folder
                                // checked=SBD, unchecked=not-SBD; node.selected is the new state
                                ? ignoreService.setDirSBD(scope.folderId, node.key, node.selected)
                                // node.selected is the new state; newly-checked means it was ignored
                                : ignoreService.togglePath(scope.folderId, node.key, node.selected);

                            promise.then(function (result) {
                                if (!result.ok) {
                                    node.setSelected(!node.selected, { noEvents: true });
                                    scope.$apply(function () { scope.ambiguous = result.ambiguous; });
                                } else {
                                    refreshAfterWrite(node);
                                }
                            });
                        },

                        // Click on folder title → expand/collapse.
                        // noAnimation avoids the "setExpanded while animating" warning on rapid clicks.
                        click: function (event, data) {
                            if (data.targetType === 'title' && data.node.isFolder()) {
                                data.node.toggleExpanded({ noAnimation: true });
                                return false;
                            }
                        }
                    });

                    tree = $.ui.fancytree.getTree(el);
                    (tree.getRootNode().children || []).forEach(function (node) {
                        refreshNodeStatus(node);
                    });
                }

                function refreshNodeStatus(node) {
                    if (!node || !node.key || !tree) return;
                    if (node.folder) {
                        ignoreService.dirSyncsAllByDefault(scope.folderId, node.key)
                            .then(function (sbd) {
                                if (!tree) return;
                                node.setSelected(sbd, { noEvents: true });
                                node.data.statusLoaded = true;
                            });
                    } else {
                        var path = node.key.replace(/^\/+/, '');
                        $http.get(
                            urlbase + '/db/file?folder=' + encodeURIComponent(scope.folderId) +
                            '&file=' + encodeURIComponent(path)
                        ).then(function (r) {
                            if (!tree) return;
                            node.setSelected(!(r.data && r.data.local && r.data.local.ignored), { noEvents: true });
                            node.data.statusLoaded = true;
                        }, function () {
                            node.data.statusLoaded = true; // not in index yet — leave unchecked
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
