// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

angular.module('syncthing.core')
    .directive('selectiveSyncBrowser', ['selectiveSyncService', '$http', '$timeout', function (selectiveSyncService, $http, $timeout) {
        'use strict';

        return {
            restrict: 'E',
            scope: { folderId: '=' },
            templateUrl: 'syncthing/folder/selectiveSyncBrowserView.html',
            link: function (scope, element) {
                var tree = null;
                var cache = {};

                scope.loading = false;
                scope.error = null;
                scope.empty = false;
                scope.filterText = '';

                function browseUrl(folderId, prefix) {
                    var url = urlbase + '/db/browse?folder=' + encodeURIComponent(folderId) + '&levels=1';
                    if (prefix) {
                        var stripped = prefix.replace(/^\/+/, '');
                        if (stripped) url += '&prefix=' + encodeURIComponent(stripped);
                    }
                    return url;
                }

                function toNodes(items, parentPath) {
                    return (items || []).map(function (item) {
                        var path = (parentPath || '') + '/' + item.name;
                        var isDir = item.type === 'FILE_INFO_TYPE_DIRECTORY';
                        var sel = selectiveSyncService.isPathSelected(scope.folderId, path);
                        var node = {
                            title: item.name,
                            key: path,
                            folder: isDir,
                            lazy: isDir,
                            selected: sel,
                            data: { path: path, isDir: isDir }
                        };
                        if (!sel && isDir && selectiveSyncService.isPathPartial(scope.folderId, path)) {
                            node.partsel = true;
                        }
                        return node;
                    });
                }

                function applySelection(node) {
                    if (!node || !node.data || !node.data.path) return;
                    var path = node.data.path;
                    var isSel = selectiveSyncService.isPathSelected(scope.folderId, path);
                    if (isSel !== node.selected) node.setSelected(isSel, { noEvents: true });
                    if (!isSel && node.folder && selectiveSyncService.isPathPartial(scope.folderId, path)) {
                        node.partsel = true; node.renderStatus();
                    }
                }

                function loadRoot() {
                    scope.loading = true;
                    scope.error = null;
                    scope.empty = false;

                    selectiveSyncService.load(scope.folderId).then(function () {
                        return $http.get(browseUrl(scope.folderId));
                    }).then(function (r) {
                        var items = r.data || [];
                        cache = {};
                        cache[''] = items;
                        scope.loading = false;

                        if (items.length === 0) {
                            scope.empty = true;
                            return;
                        }

                        var nodes = toNodes(items, '');
                        if (tree) {
                            tree.reload(nodes).done(function () {
                                tree.visit(applySelection);
                            });
                        } else {
                            $timeout(function () { mountTree(nodes); });
                        }
                    }, function (err) {
                        scope.loading = false;
                        var status = err && err.status;
                        if (status === 500 || status === 503) {
                            scope.error = 'File tree not available yet.';
                        } else {
                            scope.error = 'Failed to load file tree (error ' + status + ').';
                        }
                    });
                }

                function mountTree(nodes) {
                    var $el = $('#selective-sync-tree-' + scope.folderId, element);
                    if (!$el.length) return;

                    $el.fancytree({
                        extensions: ['filter', 'glyph'],
                        checkbox: true,
                        selectMode: 3,
                        clickFolderMode: 4,
                        autoActivate: false,
                        glyph: { preset: 'awesome5' },
                        filter: { mode: 'hide' },
                        source: nodes,
                        lazyLoad: function (event, data) {
                            var path = data.node.data.path;
                            if (cache[path]) {
                                data.result = toNodes(cache[path], path);
                                return;
                            }
                            var def = $.Deferred();
                            $http.get(browseUrl(scope.folderId, path)).then(function (r) {
                                cache[path] = r.data || [];
                                def.resolve(toNodes(cache[path], path));
                            }, function () { def.reject(); });
                            data.result = def.promise();
                        },
                        init: function (event, data) {
                            data.tree.visit(applySelection);
                        },
                        loadChildren: function (event, data) {
                            data.node.visit(applySelection);
                        },
                        select: function (event, data) {
                            onSelect(data.node);
                        },
                        click: function (event, data) {
                            if (data.targetType === 'title' && data.node.isFolder()) {
                                data.node.toggleExpanded();
                                return false;
                            }
                        }
                    });

                    tree = $el.fancytree('getTree');
                }

                function onSelect(node) {
                    var path = node.data.path;
                    if (node.selected) {
                        selectiveSyncService.selectPath(scope.folderId, path);
                    } else {
                        explodeAncestor(node);
                        selectiveSyncService.deselectPath(scope.folderId, path);
                    }
                }

                // When unchecking a node whose ancestor is the selected one,
                // explode that ancestor: deselect it and re-select its siblings
                // so that removing one item doesn't silently remove everything.
                function explodeAncestor(node) {
                    var path = node.data.path;
                    var selected = new Set(selectiveSyncService.getSelectedPaths(scope.folderId));
                    if (selected.has(path)) return;

                    var parts = path.split('/');
                    var ancestor = null;
                    for (var i = parts.length - 1; i > 0; i--) {
                        var candidate = parts.slice(0, i).join('/');
                        if (candidate && selected.has(candidate)) { ancestor = candidate; break; }
                    }
                    if (!ancestor) return;

                    selectiveSyncService.deselectPath(scope.folderId, ancestor);
                    var chain = ancestor;
                    var remainder = path.slice(ancestor.length).split('/').filter(Boolean);
                    for (var j = 0; j < remainder.length; j++) {
                        var next = chain + '/' + remainder[j];
                        (cache[chain] || []).forEach(function (s) {
                            var sp = chain + '/' + s.name;
                            if (sp !== next) selectiveSyncService.selectPath(scope.folderId, sp);
                        });
                        chain = next;
                    }
                }

                scope.refresh = function () {
                    if (tree) { try { tree.destroy(); } catch(e) {} tree = null; }
                    loadRoot();
                };

                scope.onFilter = function () {
                    if (!tree) return;
                    if (scope.filterText) tree.filterNodes(scope.filterText);
                    else tree.clearFilter();
                };

                scope.selectedCount = function () {
                    return selectiveSyncService.getSelectedPaths(scope.folderId).length;
                };

                scope.selectAll = function () {
                    (cache[''] || []).forEach(function (item) {
                        selectiveSyncService.selectPath(scope.folderId, '/' + item.name);
                    });
                    if (tree) tree.visit(applySelection);
                };

                scope.deselectAll = function () {
                    selectiveSyncService.clearSelections(scope.folderId);
                    if (tree) tree.visit(function (n) { n.setSelected(false, { noEvents: true }); });
                };

                // Load when the tab becomes visible (broadcast from controller).
                scope.$on('selectiveSyncTabVisible', function (evt, data) {
                    if (data.folderId !== scope.folderId) return;
                    if (!tree) loadRoot();
                });

                scope.$on('$destroy', function () {
                    if (tree) { try { tree.destroy(); } catch(e) {} tree = null; }
                });
            }
        };
    }]);
