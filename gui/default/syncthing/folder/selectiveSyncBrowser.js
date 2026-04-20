// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

angular.module('syncthing.core')
    .directive('selectiveSyncBrowser', ['selectiveSyncService', '$http', '$timeout', '$translate', function (selectiveSyncService, $http, $timeout, $translate) {
        'use strict';

        return {
            restrict: 'E',
            scope: {
                folderId: '='
            },
            templateUrl: 'syncthing/folder/selectiveSyncBrowserView.html',
            link: function (scope, element) {
                var tree = null;
                var cache = {};

                scope.loading = true;
                scope.error = null;
                scope.filterText = '';

                function browseErrorMessage(err) {
                    var status = (err && typeof err.status !== 'undefined') ? err.status : 0;
                    if (status === 500 || status === 503) {
                        return $translate.instant('File tree not available yet — the folder index may still be syncing. Try refreshing in a moment.');
                    }
                    return 'Failed to load file tree (error ' + status + ').';
                }

                function browseUrl(folderId, prefix) {
                    var url = urlbase + '/db/browse?folder=' + encodeURIComponent(folderId) + '&levels=1';
                    if (prefix) {
                        // db/browse expects a folder-root-relative path without
                        // a leading slash. Internal paths are stored with a
                        // leading '/' for selection bookkeeping; strip it here.
                        var stripped = prefix.replace(/^\/+/, '');
                        if (stripped) {
                            url += '&prefix=' + encodeURIComponent(stripped);
                        }
                    }
                    return url;
                }

                function toFancyNodes(items, parentPath) {
                    items = items || [];
                    return items.map(function (item) {
                        var path = (parentPath || '') + '/' + item.name;
                        var isDir = item.type === 'FILE_INFO_TYPE_DIRECTORY';
                        var selected = selectiveSyncService.isPathSelected(scope.folderId, path);
                        var node = {
                            title: item.name,
                            key: path,
                            path: path,
                            folder: isDir,
                            lazy: isDir,
                            selected: selected,
                            data: {
                                path: path,
                                size: item.size,
                                modTime: item.modTime,
                                isDir: isDir
                            }
                        };
                        if (!selected && isDir && selectiveSyncService.isPathPartial(scope.folderId, path)) {
                            node.partsel = true;
                        }
                        return node;
                    });
                }

                function loadRoot() {
                    scope.loading = true;
                    scope.error = null;

                    return selectiveSyncService.loadFromIgnores(scope.folderId).then(function () {
                        return $http.get(browseUrl(scope.folderId)).then(function (response) {
                            cache[''] = response.data || [];
                            var rootNodes = toFancyNodes(response.data || [], '');
                            scope.loading = false;
                            $timeout(function () {
                                mountTree(rootNodes);
                            });
                        }, function (err) {
                            scope.loading = false;
                            scope.error = browseErrorMessage(err);
                        });
                    }, function (err) {
                        scope.loading = false;
                        scope.error = $translate.instant('Failed to load ignore patterns.') + ' ' + (err.statusText || '');
                    });
                }

                function mountTree(rootNodes) {
                    var containerId = '#selective-sync-tree-' + scope.folderId;
                    var $el = $(containerId, element);
                    if ($el.length === 0) {
                        return;
                    }
                    if ($el.data('ui-fancytree')) {
                        $el.fancytree('destroy');
                    }

                    $el.fancytree({
                        extensions: ['filter', 'glyph'],
                        checkbox: true,
                        selectMode: 3,
                        quicksearch: true,
                        clickFolderMode: 4,
                        autoActivate: false,
                        filter: {
                            hideExpanders: true,
                            mode: 'hide'
                        },
                        glyph: {
                            preset: 'awesome5'
                        },
                        strings: {
                            loading: $translate.instant('Loading data...'),
                            loadError: $translate.instant('Failed to load file tree.'),
                            noData: $translate.instant('There are no files in this folder.')
                        },
                        debugLevel: 1,
                        source: rootNodes,
                        lazyLoad: function (event, data) {
                            var node = data.node;
                            var path = node.data.path;
                            if (cache[path]) {
                                data.result = toFancyNodes(cache[path], path);
                                return;
                            }
                            // Use $http (not $.ajax) so the AngularJS CSRF
                            // header configured on $httpProvider is sent;
                            // without it the REST API returns 403.
                            var def = $.Deferred();
                            $http.get(browseUrl(scope.folderId, path)).then(function (response) {
                                var items = response.data || [];
                                cache[path] = items;
                                def.resolve(toFancyNodes(items, path));
                            }, function (err) {
                                scope.error = browseErrorMessage(err);
                                def.reject();
                            });
                            data.result = def.promise();
                        },
                        init: function (event, data) {
                            // After initial render, apply selection state for any descendants
                            data.tree.visit(function (node) {
                                applySelectionToNode(node);
                            });
                            // If the tree initialized empty but the root-level
                            // cache has entries (e.g. mount raced with the
                            // in-place modal transition), reload from the
                            // cached root nodes.
                            var rootNode = data.tree.getRootNode();
                            var hasChildren = rootNode && rootNode.children && rootNode.children.length > 0;
                            if (!hasChildren && cache[''] && cache[''].length > 0) {
                                data.tree.reload(toFancyNodes(cache[''], ''));
                            } else if (!hasChildren) {
                                // Nothing in cache either — retry the load once
                                // the DOM/layout has settled.
                                $timeout(function () { loadRoot(); }, 0);
                            }
                        },
                        loadChildren: function (event, data) {
                            data.node.visit(function (node) {
                                applySelectionToNode(node);
                            });
                        },
                        select: function (event, data) {
                            onNodeSelect(data.node);
                        },
                        click: function (event, data) {
                            // Clicking a folder row's title should expand/collapse
                            // rather than activate-select. The checkbox is still
                            // clickable and drives selection separately.
                            if (data.targetType === 'title' && data.node.isFolder()) {
                                data.node.toggleExpanded();
                                return false;
                            }
                        }
                    });

                    tree = $el.fancytree('getTree');
                }

                function applySelectionToNode(node) {
                    if (!node || !node.data || !node.data.path) {
                        return;
                    }
                    var path = node.data.path;
                    var isSel = selectiveSyncService.isPathSelected(scope.folderId, path);
                    if (isSel && !node.selected) {
                        node.setSelected(true, { noEvents: true });
                    }
                    if (!isSel && node.selected) {
                        node.setSelected(false, { noEvents: true });
                    }
                    if (!isSel && node.folder && selectiveSyncService.isPathPartial(scope.folderId, path)) {
                        node.partsel = true;
                        node.renderStatus();
                    }
                }

                function onNodeSelect(node) {
                    if (!node || !node.data || !node.data.path) {
                        return;
                    }
                    var path = node.data.path;
                    if (node.selected) {
                        // If an ancestor is already selected, this is a no-op in the service
                        if (!selectiveSyncService.isPathSelected(scope.folderId, path)) {
                            selectiveSyncService.selectPath(scope.folderId, path);
                        }
                    } else {
                        // If an ancestor directory was the one whitelisting this node,
                        // explode that ancestor: remove it, then add all siblings of path's
                        // chain except the one being deselected.
                        explodeAncestorIfNeeded(node);
                        selectiveSyncService.deselectPath(scope.folderId, path);
                    }
                }

                function explodeAncestorIfNeeded(node) {
                    var path = node.data.path;
                    var selected = new Set(selectiveSyncService.getSelectedPaths(scope.folderId));
                    if (selected.has(path)) {
                        return;
                    }
                    // Find the closest selected ancestor
                    var parts = path.split('/');
                    var ancestor = null;
                    for (var i = parts.length - 1; i > 0; i--) {
                        var candidate = parts.slice(0, i).join('/');
                        if (candidate && selected.has(candidate)) {
                            ancestor = candidate;
                            break;
                        }
                    }
                    if (!ancestor) {
                        return;
                    }
                    // Walk down from ancestor toward path; at each level, add siblings
                    // other than the one on the chain to keep them selected.
                    selectiveSyncService.deselectPath(scope.folderId, ancestor);
                    var chainPath = ancestor;
                    var remainder = path.slice(ancestor.length).split('/').filter(function (p) { return p.length > 0; });
                    for (var j = 0; j < remainder.length; j++) {
                        var nextChain = chainPath + '/' + remainder[j];
                        var siblings = cache[chainPath] || [];
                        siblings.forEach(function (s) {
                            var sPath = chainPath + '/' + s.name;
                            if (sPath !== nextChain) {
                                selectiveSyncService.selectPath(scope.folderId, sPath);
                            }
                        });
                        chainPath = nextChain;
                    }
                }

                scope.refresh = function () {
                    cache = {};
                    if (tree) {
                        tree.destroy();
                        tree = null;
                    }
                    loadRoot();
                };

                scope.onFilter = function () {
                    if (!tree) return;
                    if (scope.filterText) {
                        tree.filterNodes(scope.filterText);
                    } else {
                        tree.clearFilter();
                    }
                };

                scope.selectedCount = function () {
                    return selectiveSyncService.getSelectedPaths(scope.folderId).length;
                };

                scope.selectAll = function () {
                    // Select every root-level entry so everything is covered.
                    var rootItems = cache[''] || [];
                    rootItems.forEach(function (item) {
                        selectiveSyncService.selectPath(scope.folderId, '/' + item.name);
                    });
                    if (tree) {
                        tree.visit(function (node) {
                            applySelectionToNode(node);
                        });
                    }
                };

                scope.deselectAll = function () {
                    selectiveSyncService.clearSelections(scope.folderId);
                    if (tree) {
                        tree.visit(function (node) {
                            node.setSelected(false, { noEvents: true });
                        });
                    }
                };

                // Exposed so the enclosing modal can persist selections on Save.
                scope.save = function () {
                    return selectiveSyncService.saveToIgnores(scope.folderId);
                };

                scope.$on('$destroy', function () {
                    if (tree) {
                        try { tree.destroy(); } catch (e) {}
                        tree = null;
                    }
                });

                // Watch folderId so that when the directive is (re)instantiated
                // and the binding resolves, or the bound folder changes, we
                // (re)load the tree. More reliable than event broadcasts: ng-if
                // inserts the DOM element, but jQuery/FancyTree needs the
                // element to have layout dimensions before it can initialize.
                // A 300ms delay gives AngularJS and the browser time to do a
                // layout pass after ng-if flips.
                scope.$watch('folderId', function (newVal, oldVal) {
                    if (!newVal) {
                        return;
                    }
                    $timeout(function () {
                        if (!tree || !tree.getRootNode().hasChildren()) {
                            loadRoot();
                        }
                    }, 300);
                });
            }
        };
    }]);
