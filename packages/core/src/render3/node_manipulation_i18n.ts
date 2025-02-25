/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {assertDomNode, assertIndexInRange} from '../util/assert';

import {TNode, TNodeFlags, TNodeType} from './interfaces/node';
import {Renderer} from './interfaces/renderer';
import {RElement, RNode} from './interfaces/renderer_dom';
import {LView} from './interfaces/view';
import {getInsertInFrontOfRNodeWithNoI18n, nativeInsertBefore} from './node_manipulation';
import {unwrapRNode} from './util/view_utils';


/**
 * Find a node in front of which `currentTNode` should be inserted (takes i18n into account).
 *
 * 查找应该在其前面插入 `currentTNode` 的节点（考虑 i18n）。
 *
 * This method determines the `RNode` in front of which we should insert the `currentRNode`. This
 * takes `TNode.insertBeforeIndex` into account.
 *
 * 此方法确定我们应该在其前面插入 `currentRNode` 的 `RNode` 。这会考虑 `TNode.insertBeforeIndex` 。
 *
 * @param parentTNode parent `TNode`
 *
 * 父 `TNode`
 *
 * @param currentTNode current `TNode` (The node which we would like to insert into the DOM)
 *
 * 当前 `TNode`（我们要插入到 DOM 中的节点）
 *
 * @param lView current `LView`
 *
 * 当前的 `LView`
 *
 */
export function getInsertInFrontOfRNodeWithI18n(
    parentTNode: TNode, currentTNode: TNode, lView: LView): RNode|null {
  const tNodeInsertBeforeIndex = currentTNode.insertBeforeIndex;
  const insertBeforeIndex =
      Array.isArray(tNodeInsertBeforeIndex) ? tNodeInsertBeforeIndex[0] : tNodeInsertBeforeIndex;
  if (insertBeforeIndex === null) {
    return getInsertInFrontOfRNodeWithNoI18n(parentTNode, currentTNode, lView);
  } else {
    ngDevMode && assertIndexInRange(lView, insertBeforeIndex);
    return unwrapRNode(lView[insertBeforeIndex]);
  }
}


/**
 * Process `TNode.insertBeforeIndex` by adding i18n text nodes.
 *
 * 通过添加 i18n 文本节点来处理 `TNode.insertBeforeIndex` 。
 *
 * See `TNode.insertBeforeIndex`
 *
 * 请参阅 `TNode.insertBeforeIndex`
 *
 */
export function processI18nInsertBefore(
    renderer: Renderer, childTNode: TNode, lView: LView, childRNode: RNode|RNode[],
    parentRElement: RElement|null): void {
  const tNodeInsertBeforeIndex = childTNode.insertBeforeIndex;
  if (Array.isArray(tNodeInsertBeforeIndex)) {
    // An array indicates that there are i18n nodes that need to be added as children of this
    // `childRNode`. These i18n nodes were created before this `childRNode` was available and so
    // only now can be added. The first element of the array is the normal index where we should
    // insert the `childRNode`. Additional elements are the extra nodes to be added as children of
    // `childRNode`.
    ngDevMode && assertDomNode(childRNode);
    let i18nParent: RElement|null = childRNode as RElement;
    let anchorRNode: RNode|null = null;
    if (!(childTNode.type & TNodeType.AnyRNode)) {
      anchorRNode = i18nParent;
      i18nParent = parentRElement;
    }
    if (i18nParent !== null && childTNode.componentOffset === -1) {
      for (let i = 1; i < tNodeInsertBeforeIndex.length; i++) {
        // No need to `unwrapRNode` because all of the indexes point to i18n text nodes.
        // see `assertDomNode` below.
        const i18nChild = lView[tNodeInsertBeforeIndex[i]];
        nativeInsertBefore(renderer, i18nParent, i18nChild, anchorRNode, false);
      }
    }
  }
}
