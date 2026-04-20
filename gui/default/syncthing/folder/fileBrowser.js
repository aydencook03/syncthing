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
            templateUrl: 'syncthing/folder/fileBrowserView.html',
            link: function (scope) {
                var tree = null;
                var cache = {};

                scope.folderId   = null;
                scope.folderName = null;
                scope.loading    = false;
                scope.error      = null;
                scope.empty      = false;
                scope.ambiguous  = null;

                // Listen for open requests from anywhere in the app.
                scope.$on('openFileBrowser', function (evt, data) {
                    scope.folderId   = data.folderId;
                    scope.folderName = data.folderName || data.folderId;
                    scope.ambiguous  = null;
                    if (tree) { try { tree.destroy(); } catch(e) {} tree = null; }
                    cache = {};
                    $('#fileBrowserModal').modal('show');
                    scope.load();
                });

                scope.load = function () {
                    scope.loading = true;
                    scope.error   = null;
                    scope.empty   = false;

                    $http.get(urlbase + '/db/browse?folder=' + encodeURIComponent(scope.folderId) + '&levels=1')
                        .then(function (r) {
                            scope.loading = false;
                            var items = r.data || [];
                            cache[''] = items;
                            if (items.length === 0) { scope.empty = true; return; }
                            $timeout(function () { mountTree(toNodes(items, '')); });
                        }, function (err) {
                            scope.loading = false;
                            scope.error = 'Failed to load file tree (' + (err.status || 'network error') + ').';
                        });
                };

                // Convert db/browse items to FancyTree node defs.
                // Checkbox state is unknown until db/file is fetched; start unchecked.
                // Status is loaded lazily per node on expand/render.
                function toNodes(items, parentPath) {
                    return items.map(function (item) {
                        var path = (parentPath ? parentPath : '') + '/' + item.name;
                        var isDir = item.type === 'FILE_INFO_TYPE_DIRECTORY';
                        return {
                            title: nodeTitle(item),
                            key: path,
                            folder: isDir,
                            lazy: isDir,
                            selected: false,   // resolved async via loadNodeStatus
                            checkbox: true,
                            data: { path: path, item: item, statusLoaded: false }
                        };
                    });
                }

                function nodeTitle(item) {
                    var size = item.size ? ' <small class="text-muted">(' + humanSize(item.size) + ')</small>' : '';
                    return '<span>' + escHtml(item.name) + size + '</span>';
                }

                function mountTree(nodes) {
                    var el = document.getElementById('file-browser-tree-' + scope.folderId);
                    if (!el) return;
                    var $el = $(el);

                    $el.fancytree({
                        extensions: ['glyph'],
                        checkbox: true,
                        selectMode: 2,          // hierarchical (parent controls children)
                        clickFolderMode: 4,     // click title → expand; click checkbox → select
                        autoActivate: false,
                        glyph: { preset: 'awesome5' },
                        source: nodes,

                        // Lazy-load children when a folder is expanded.
                        lazyLoad: function (event, data) {
                            var path = data.node.key;
                            if (cache[path]) {
                                data.result = toNodes(cache[path], path);
                                loadStatusForNodes(data.result.map(function(n) { return data.node.tree.getNodeByKey(n.key); }));
                                return;
                            }
                            var stripped = path.replace(/^\/+/, '');
                            data.result = $http.get(
                                urlbase + '/db/browse?folder=' + encodeURIComponent(scope.folderId) +
                                '&levels=1&prefix=' + encodeURIComponent(stripped)
                            ).then(function (r) {
                                cache[path] = r.data || [];
                                return toNodes(cache[path], path);
                            });
                        },

                        // After children load, fetch their ignore status.
                        loadChildren: function (event, data) {
                            loadStatusForNodes(data.node.children || []);
                        },

                        // User toggled a checkbox.
                        select: function (event, data) {
                            var node = data.node;
                            var path = node.key;
                            // node.selected reflects the NEW state after the click.
                            // If now selected → it was ignored before → user wants to START syncing.
                            // If now deselected → it was syncing before → user wants to STOP syncing.
                            var wasIgnored = node.selected;
                            scope.ambiguous = null;

                            ignoreService.togglePath(scope.folderId, path, wasIgnored)
                                .then(function (result) {
                                    if (!result.ok) {
                                        // Revert the checkbox to its prior state and show the ambiguity notice.
                                        node.setSelected(!wasIgnored, { noEvents: true });
                                        scope.$apply(function () { scope.ambiguous = result.ambiguous; });
                                    }
                                    // On success Syncthing will re-evaluate ignores automatically;
                                    // refresh this node's status after a short delay.
                                    else {
                                        $timeout(function () { refreshNodeStatus(node); }, 800);
                                    }
                                });
                        },

                        // Click on title → expand/collapse folder.
                        click: function (event, data) {
                            if (data.targetType === 'title' && data.node.isFolder()) {
                                data.node.toggleExpanded();
                                return false;
                            }
                        }
                    });

                    tree = $.ui.fancytree.getTree(el);

                    // Load ignore status for the root nodes.
                    loadStatusForNodes(tree.getRootNode().children || []);
                }

                // Fetch db/file for a batch of nodes and set their checkbox state.
                function loadStatusForNodes(nodes) {
                    (nodes || []).forEach(function (node) {
                        if (!node || !node.data || node.data.statusLoaded) return;
                        refreshNodeStatus(node);
                    });
                }

                function refreshNodeStatus(node) {
                    if (!node || !node.key) return;
                    var path = node.key.replace(/^\/+/, ''); // db/file wants no leading slash
                    $http.get(
                        urlbase + '/db/file?folder=' + encodeURIComponent(scope.folderId) +
                        '&file=' + encodeURIComponent(path)
                    ).then(function (r) {
                        var ignored = r.data && r.data.local && r.data.local.ignored;
                        node.setSelected(!ignored, { noEvents: true });
                        node.data.statusLoaded = true;
                    }, function () {
                        // File not in local index yet — leave unchecked.
                        node.data.statusLoaded = true;
                    });
                }

                scope.openIgnorePatterns = function () {
                    $('#fileBrowserModal').modal('hide');
                    // Let the controller know to open the edit modal on the Ignore Patterns tab.
                    scope.$emit('openIgnorePatternsFor', { folderId: scope.folderId });
                };

                // Utilities
                function humanSize(bytes) {
                    if (bytes === 0) return '0 B';
                    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
                    var i = Math.floor(Math.log(bytes) / Math.log(1024));
                    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
                }

                function escHtml(s) {
                    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                }
            }
        };
    }]);
