/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Injector} from '../../di/injector';
import {ErrorHandler} from '../../error_handler';
import {RuntimeError, RuntimeErrorCode} from '../../errors';
import {DoCheck, OnChanges, OnInit} from '../../interface/lifecycle_hooks';
import {SchemaMetadata} from '../../metadata/schema';
import {ViewEncapsulation} from '../../metadata/view';
import {validateAgainstEventAttributes, validateAgainstEventProperties} from '../../sanitization/sanitization';
import {Sanitizer} from '../../sanitization/sanitizer';
import {assertDefined, assertEqual, assertGreaterThan, assertGreaterThanOrEqual, assertIndexInRange, assertNotEqual, assertNotSame, assertSame, assertString} from '../../util/assert';
import {escapeCommentText} from '../../util/dom';
import {normalizeDebugBindingName, normalizeDebugBindingValue} from '../../util/ng_reflect';
import {stringify} from '../../util/stringify';
import {assertFirstCreatePass, assertFirstUpdatePass, assertLContainer, assertLView, assertTNodeForLView, assertTNodeForTView} from '../assert';
import {attachPatchData, readPatchedLView} from '../context_discovery';
import {getFactoryDef} from '../definition_factory';
import {diPublicInInjector, getNodeInjectable, getOrCreateNodeInjectorForNode} from '../di';
import {throwMultipleComponentError} from '../errors';
import {executeCheckHooks, executeInitAndCheckHooks, incrementInitPhaseFlags} from '../hooks';
import {CONTAINER_HEADER_OFFSET, HAS_TRANSPLANTED_VIEWS, LContainer, MOVED_VIEWS} from '../interfaces/container';
import {ComponentDef, ComponentTemplate, DirectiveDef, DirectiveDefListOrFactory, HostBindingsFunction, HostDirectiveBindingMap, HostDirectiveDefs, PipeDefListOrFactory, RenderFlags, ViewQueriesFunction} from '../interfaces/definition';
import {NodeInjectorFactory} from '../interfaces/injector';
import {getUniqueLViewId} from '../interfaces/lview_tracking';
import {AttributeMarker, InitialInputData, InitialInputs, LocalRefExtractor, PropertyAliases, PropertyAliasValue, TAttributes, TConstantsOrFactory, TContainerNode, TDirectiveHostNode, TElementContainerNode, TElementNode, TIcuContainerNode, TNode, TNodeFlags, TNodeType, TProjectionNode} from '../interfaces/node';
import {Renderer, RendererFactory} from '../interfaces/renderer';
import {RComment, RElement, RNode, RText} from '../interfaces/renderer_dom';
import {SanitizerFn} from '../interfaces/sanitization';
import {isComponentDef, isComponentHost, isContentQueryHost, isRootView} from '../interfaces/type_checks';
import {CHILD_HEAD, CHILD_TAIL, CLEANUP, CONTEXT, DECLARATION_COMPONENT_VIEW, DECLARATION_VIEW, EMBEDDED_VIEW_INJECTOR, FLAGS, HEADER_OFFSET, HOST, HostBindingOpCodes, ID, InitPhaseState, INJECTOR, LView, LViewFlags, NEXT, PARENT, RENDERER, RENDERER_FACTORY, SANITIZER, T_HOST, TData, TRANSPLANTED_VIEWS_TO_REFRESH, TVIEW, TView, TViewType} from '../interfaces/view';
import {assertPureTNodeType, assertTNodeType} from '../node_assert';
import {updateTextNode} from '../node_manipulation';
import {isInlineTemplate, isNodeMatchingSelectorList} from '../node_selector_matcher';
import {profiler, ProfilerEvent} from '../profiler';
import {enterView, getBindingsEnabled, getCurrentDirectiveIndex, getCurrentParentTNode, getCurrentTNode, getCurrentTNodePlaceholderOk, getSelectedIndex, isCurrentTNodeParent, isInCheckNoChangesMode, isInI18nBlock, leaveView, setBindingIndex, setBindingRootForHostBindings, setCurrentDirectiveIndex, setCurrentQueryIndex, setCurrentTNode, setIsInCheckNoChangesMode, setSelectedIndex} from '../state';
import {NO_CHANGE} from '../tokens';
import {mergeHostAttrs} from '../util/attrs_utils';
import {INTERPOLATION_DELIMITER} from '../util/misc_utils';
import {renderStringify, stringifyForError} from '../util/stringify_utils';
import {getFirstLContainer, getLViewParent, getNextLContainer} from '../util/view_traversal_utils';
import {getComponentLViewByIndex, getNativeByIndex, getNativeByTNode, isCreationMode, resetPreOrderHookFlags, unwrapLView, updateTransplantedViewCount, viewAttachedToChangeDetector} from '../util/view_utils';

import {selectIndexInternal} from './advance';
import {ɵɵdirectiveInject} from './di';
import {handleUnknownPropertyError, isPropertyValid, matchingSchemas} from './element_validation';
import {attachLContainerDebug, attachLViewDebug, cloneToLViewFromTViewBlueprint, cloneToTViewData, LCleanup, LViewBlueprint, MatchesArray, TCleanup, TNodeDebug, TNodeInitialInputs, TNodeLocalNames, TViewComponents, TViewConstructor} from './lview_debug';

/**
 * Invoke `HostBindingsFunction`s for view.
 *
 * 调用 `HostBindingsFunction` 以进行查看。
 *
 * This methods executes `TView.hostBindingOpCodes`. It is used to execute the
 * `HostBindingsFunction`s associated with the current `LView`.
 *
 * 此方法执行 `TView.hostBindingOpCodes` 。它用于执行与当前 `HostBindingsFunction` 关联的 `LView` 。
 *
 * @param tView Current `TView`.
 *
 * 当前 `TView` 。
 *
 * @param lView Current `LView`.
 *
 * 当前 `LView` 。
 *
 */
export function processHostBindingOpCodes(tView: TView, lView: LView): void {
  const hostBindingOpCodes = tView.hostBindingOpCodes;
  if (hostBindingOpCodes === null) return;
  try {
    for (let i = 0; i < hostBindingOpCodes.length; i++) {
      const opCode = hostBindingOpCodes[i] as number;
      if (opCode < 0) {
        // Negative numbers are element indexes.
        setSelectedIndex(~opCode);
      } else {
        // Positive numbers are NumberTuple which store bindingRootIndex and directiveIndex.
        const directiveIdx = opCode;
        const bindingRootIndx = hostBindingOpCodes[++i] as number;
        const hostBindingFn = hostBindingOpCodes[++i] as HostBindingsFunction<any>;
        setBindingRootForHostBindings(bindingRootIndx, directiveIdx);
        const context = lView[directiveIdx];
        hostBindingFn(RenderFlags.Update, context);
      }
    }
  } finally {
    setSelectedIndex(-1);
  }
}


/**
 * Refreshes all content queries declared by directives in a given view
 *
 * 刷新给定视图中指令声明的所有内容查询
 *
 */
function refreshContentQueries(tView: TView, lView: LView): void {
  const contentQueries = tView.contentQueries;
  if (contentQueries !== null) {
    for (let i = 0; i < contentQueries.length; i += 2) {
      const queryStartIdx = contentQueries[i];
      const directiveDefIdx = contentQueries[i + 1];
      if (directiveDefIdx !== -1) {
        const directiveDef = tView.data[directiveDefIdx] as DirectiveDef<any>;
        ngDevMode && assertDefined(directiveDef, 'DirectiveDef not found.');
        ngDevMode &&
            assertDefined(directiveDef.contentQueries, 'contentQueries function should be defined');
        setCurrentQueryIndex(queryStartIdx);
        directiveDef.contentQueries!(RenderFlags.Update, lView[directiveDefIdx], directiveDefIdx);
      }
    }
  }
}

/**
 * Refreshes child components in the current view (update mode).
 *
 * 刷新当前视图中的子组件（更新模式）。
 *
 */
function refreshChildComponents(hostLView: LView, components: number[]): void {
  for (let i = 0; i < components.length; i++) {
    refreshComponent(hostLView, components[i]);
  }
}

/**
 * Renders child components in the current view (creation mode).
 *
 * 在当前视图中渲染子组件（创建模式）。
 *
 */
function renderChildComponents(hostLView: LView, components: number[]): void {
  for (let i = 0; i < components.length; i++) {
    renderComponent(hostLView, components[i]);
  }
}

export function createLView<T>(
    parentLView: LView|null, tView: TView, context: T|null, flags: LViewFlags, host: RElement|null,
    tHostNode: TNode|null, rendererFactory: RendererFactory|null, renderer: Renderer|null,
    sanitizer: Sanitizer|null, injector: Injector|null,
    embeddedViewInjector: Injector|null): LView {
  const lView =
      ngDevMode ? cloneToLViewFromTViewBlueprint(tView) : tView.blueprint.slice() as LView;
  lView[HOST] = host;
  lView[FLAGS] = flags | LViewFlags.CreationMode | LViewFlags.Attached | LViewFlags.FirstLViewPass;
  if (embeddedViewInjector !== null ||
      (parentLView && (parentLView[FLAGS] & LViewFlags.HasEmbeddedViewInjector))) {
    lView[FLAGS] |= LViewFlags.HasEmbeddedViewInjector;
  }
  resetPreOrderHookFlags(lView);
  ngDevMode && tView.declTNode && parentLView && assertTNodeForLView(tView.declTNode, parentLView);
  lView[PARENT] = lView[DECLARATION_VIEW] = parentLView;
  lView[CONTEXT] = context;
  lView[RENDERER_FACTORY] = (rendererFactory || parentLView && parentLView[RENDERER_FACTORY])!;
  ngDevMode && assertDefined(lView[RENDERER_FACTORY], 'RendererFactory is required');
  lView[RENDERER] = (renderer || parentLView && parentLView[RENDERER])!;
  ngDevMode && assertDefined(lView[RENDERER], 'Renderer is required');
  lView[SANITIZER] = sanitizer || parentLView && parentLView[SANITIZER] || null!;
  lView[INJECTOR as any] = injector || parentLView && parentLView[INJECTOR] || null;
  lView[T_HOST] = tHostNode;
  lView[ID] = getUniqueLViewId();
  lView[EMBEDDED_VIEW_INJECTOR as any] = embeddedViewInjector;
  ngDevMode &&
      assertEqual(
          tView.type == TViewType.Embedded ? parentLView !== null : true, true,
          'Embedded views must have parentLView');
  lView[DECLARATION_COMPONENT_VIEW] =
      tView.type == TViewType.Embedded ? parentLView![DECLARATION_COMPONENT_VIEW] : lView;
  ngDevMode && attachLViewDebug(lView);
  return lView;
}

/**
 * Create and stores the TNode, and hooks it up to the tree.
 *
 * 创建并存储 TNode，并将其连接到树。
 *
 * @param tView The current `TView`.
 *
 * 当前的 `TView` 。
 *
 * @param index The index at which the TNode should be saved (null if view, since they are not
 * saved).
 *
 * 应该保存 TNode 的索引（如果是视图，则为 null ，因为它们没有保存）。
 *
 * @param type The type of TNode to create
 *
 * 要创建的 TNode 的类型
 *
 * @param native The native element for this node, if applicable
 *
 * 此节点的本机元素（如果适用）
 *
 * @param name The tag name of the associated native element, if applicable
 *
 * 关联的本机元素的标签名称（如果适用）
 *
 * @param attrs Any attrs for the native element, if applicable
 *
 * 本机元素的任何 attrs（如果适用）
 *
 */
export function getOrCreateTNode(
    tView: TView, index: number, type: TNodeType.Element|TNodeType.Text, name: string|null,
    attrs: TAttributes|null): TElementNode;
export function getOrCreateTNode(
    tView: TView, index: number, type: TNodeType.Container, name: string|null,
    attrs: TAttributes|null): TContainerNode;
export function getOrCreateTNode(
    tView: TView, index: number, type: TNodeType.Projection, name: null,
    attrs: TAttributes|null): TProjectionNode;
export function getOrCreateTNode(
    tView: TView, index: number, type: TNodeType.ElementContainer, name: string|null,
    attrs: TAttributes|null): TElementContainerNode;
export function getOrCreateTNode(
    tView: TView, index: number, type: TNodeType.Icu, name: null,
    attrs: TAttributes|null): TElementContainerNode;
export function getOrCreateTNode(
    tView: TView, index: number, type: TNodeType, name: string|null, attrs: TAttributes|null):
    TElementNode&TContainerNode&TElementContainerNode&TProjectionNode&TIcuContainerNode {
  ngDevMode && index !== 0 &&  // 0 are bogus nodes and they are OK. See `createContainerRef` in
                               // `view_engine_compatibility` for additional context.
      assertGreaterThanOrEqual(index, HEADER_OFFSET, 'TNodes can\'t be in the LView header.');
  // Keep this function short, so that the VM will inline it.
  ngDevMode && assertPureTNodeType(type);
  let tNode = tView.data[index] as TNode;
  if (tNode === null) {
    tNode = createTNodeAtIndex(tView, index, type, name, attrs);
    if (isInI18nBlock()) {
      // If we are in i18n block then all elements should be pre declared through `Placeholder`
      // See `TNodeType.Placeholder` and `LFrame.inI18n` for more context.
      // If the `TNode` was not pre-declared than it means it was not mentioned which means it was
      // removed, so we mark it as detached.
      tNode.flags |= TNodeFlags.isDetached;
    }
  } else if (tNode.type & TNodeType.Placeholder) {
    tNode.type = type;
    tNode.value = name;
    tNode.attrs = attrs;
    const parent = getCurrentParentTNode();
    tNode.injectorIndex = parent === null ? -1 : parent.injectorIndex;
    ngDevMode && assertTNodeForTView(tNode, tView);
    ngDevMode && assertEqual(index, tNode.index, 'Expecting same index');
  }
  setCurrentTNode(tNode, true);
  return tNode as TElementNode & TContainerNode & TElementContainerNode & TProjectionNode &
      TIcuContainerNode;
}

export function createTNodeAtIndex(
    tView: TView, index: number, type: TNodeType, name: string|null, attrs: TAttributes|null) {
  const currentTNode = getCurrentTNodePlaceholderOk();
  const isParent = isCurrentTNodeParent();
  const parent = isParent ? currentTNode : currentTNode && currentTNode.parent;
  // Parents cannot cross component boundaries because components will be used in multiple places.
  const tNode = tView.data[index] =
      createTNode(tView, parent as TElementNode | TContainerNode, type, index, name, attrs);
  // Assign a pointer to the first child node of a given view. The first node is not always the one
  // at index 0, in case of i18n, index 0 can be the instruction `i18nStart` and the first node has
  // the index 1 or more, so we can't just check node index.
  if (tView.firstChild === null) {
    tView.firstChild = tNode;
  }
  if (currentTNode !== null) {
    if (isParent) {
      // FIXME(misko): This logic looks unnecessarily complicated. Could we simplify?
      if (currentTNode.child == null && tNode.parent !== null) {
        // We are in the same view, which means we are adding content node to the parent view.
        currentTNode.child = tNode;
      }
    } else {
      if (currentTNode.next === null) {
        // In the case of i18n the `currentTNode` may already be linked, in which case we don't want
        // to break the links which i18n created.
        currentTNode.next = tNode;
      }
    }
  }
  return tNode;
}

/**
 * When elements are created dynamically after a view blueprint is created (e.g. through
 * i18nApply()), we need to adjust the blueprint for future
 * template passes.
 *
 * 在创建视图蓝图后动态创建元素时（例如通过 i18nApply()），我们需要为未来的模板传递调整蓝图。
 *
 * @param tView `TView` associated with `LView`
 *
 * 与 `TView` 关联的 `LView`
 *
 * @param lView The `LView` containing the blueprint to adjust
 *
 * 包含要调整的蓝图的 `LView`
 *
 * @param numSlotsToAlloc The number of slots to alloc in the LView, should be >0
 *
 * LView 中要分配的插槽数，应该> 0
 *
 * @param initialValue Initial value to store in blueprint
 *
 * 要存储在蓝图中的初始值
 *
 */
export function allocExpando(
    tView: TView, lView: LView, numSlotsToAlloc: number, initialValue: any): number {
  if (numSlotsToAlloc === 0) return -1;
  if (ngDevMode) {
    assertFirstCreatePass(tView);
    assertSame(tView, lView[TVIEW], '`LView` must be associated with `TView`!');
    assertEqual(tView.data.length, lView.length, 'Expecting LView to be same size as TView');
    assertEqual(
        tView.data.length, tView.blueprint.length, 'Expecting Blueprint to be same size as TView');
    assertFirstUpdatePass(tView);
  }
  const allocIdx = lView.length;
  for (let i = 0; i < numSlotsToAlloc; i++) {
    lView.push(initialValue);
    tView.blueprint.push(initialValue);
    tView.data.push(null);
  }
  return allocIdx;
}


//////////////////////////
//// Render
//////////////////////////

/**
 * Processes a view in the creation mode. This includes a number of steps in a specific order:
 *
 * 在创建模式下处理视图。这包括按特定顺序的许多步骤：
 *
 * - creating view query functions (if any);
 *
 *   创建视图查询函数（如果有）；
 *
 * - executing a template function in the creation mode;
 *
 *   在创建模式下执行模板函数；
 *
 * - updating static queries (if any);
 *
 *   更新静态查询（如果有）；
 *
 * - creating child components defined in a given view.
 *
 *   创建给定视图中定义的子组件。
 *
 */
export function renderView<T>(tView: TView, lView: LView<T>, context: T): void {
  ngDevMode && assertEqual(isCreationMode(lView), true, 'Should be run in creation mode');
  enterView(lView);
  try {
    const viewQuery = tView.viewQuery;
    if (viewQuery !== null) {
      executeViewQueryFn<T>(RenderFlags.Create, viewQuery, context);
    }

    // Execute a template associated with this view, if it exists. A template function might not be
    // defined for the root component views.
    const templateFn = tView.template;
    if (templateFn !== null) {
      executeTemplate<T>(tView, lView, templateFn, RenderFlags.Create, context);
    }

    // This needs to be set before children are processed to support recursive components.
    // This must be set to false immediately after the first creation run because in an
    // ngFor loop, all the views will be created together before update mode runs and turns
    // off firstCreatePass. If we don't set it here, instances will perform directive
    // matching, etc again and again.
    if (tView.firstCreatePass) {
      tView.firstCreatePass = false;
    }

    // We resolve content queries specifically marked as `static` in creation mode. Dynamic
    // content queries are resolved during change detection (i.e. update mode), after embedded
    // views are refreshed (see block above).
    if (tView.staticContentQueries) {
      refreshContentQueries(tView, lView);
    }

    // We must materialize query results before child components are processed
    // in case a child component has projected a container. The LContainer needs
    // to exist so the embedded views are properly attached by the container.
    if (tView.staticViewQueries) {
      executeViewQueryFn<T>(RenderFlags.Update, tView.viewQuery!, context);
    }

    // Render child component views.
    const components = tView.components;
    if (components !== null) {
      renderChildComponents(lView, components);
    }

  } catch (error) {
    // If we didn't manage to get past the first template pass due to
    // an error, mark the view as corrupted so we can try to recover.
    if (tView.firstCreatePass) {
      tView.incompleteFirstPass = true;
      tView.firstCreatePass = false;
    }

    throw error;
  } finally {
    lView[FLAGS] &= ~LViewFlags.CreationMode;
    leaveView();
  }
}

/**
 * Processes a view in update mode. This includes a number of steps in a specific order:
 *
 * 以更新模式处理视图。这包括按特定顺序的许多步骤：
 *
 * - executing a template function in update mode;
 *
 *   在更新模式下执行模板函数；
 *
 * - executing hooks;
 *
 *   执行钩子；
 *
 * - refreshing queries;
 *
 *   刷新查询；
 *
 * - setting host bindings;
 *
 *   设置宿主绑定；
 *
 * - refreshing child (embedded and component) views.
 *
 *   刷新子（嵌入式和组件）视图。
 *
 */
export function refreshView<T>(
    tView: TView, lView: LView, templateFn: ComponentTemplate<{}>|null, context: T) {
  ngDevMode && assertEqual(isCreationMode(lView), false, 'Should be run in update mode');
  const flags = lView[FLAGS];
  if ((flags & LViewFlags.Destroyed) === LViewFlags.Destroyed) return;
  enterView(lView);
  // Check no changes mode is a dev only mode used to verify that bindings have not changed
  // since they were assigned. We do not want to execute lifecycle hooks in that mode.
  const isInCheckNoChangesPass = ngDevMode && isInCheckNoChangesMode();
  try {
    resetPreOrderHookFlags(lView);

    setBindingIndex(tView.bindingStartIndex);
    if (templateFn !== null) {
      executeTemplate(tView, lView, templateFn, RenderFlags.Update, context);
    }

    const hooksInitPhaseCompleted =
        (flags & LViewFlags.InitPhaseStateMask) === InitPhaseState.InitPhaseCompleted;

    // execute pre-order hooks (OnInit, OnChanges, DoCheck)
    // PERF WARNING: do NOT extract this to a separate function without running benchmarks
    if (!isInCheckNoChangesPass) {
      if (hooksInitPhaseCompleted) {
        const preOrderCheckHooks = tView.preOrderCheckHooks;
        if (preOrderCheckHooks !== null) {
          executeCheckHooks(lView, preOrderCheckHooks, null);
        }
      } else {
        const preOrderHooks = tView.preOrderHooks;
        if (preOrderHooks !== null) {
          executeInitAndCheckHooks(lView, preOrderHooks, InitPhaseState.OnInitHooksToBeRun, null);
        }
        incrementInitPhaseFlags(lView, InitPhaseState.OnInitHooksToBeRun);
      }
    }

    // First mark transplanted views that are declared in this lView as needing a refresh at their
    // insertion points. This is needed to avoid the situation where the template is defined in this
    // `LView` but its declaration appears after the insertion component.
    markTransplantedViewsForRefresh(lView);
    refreshEmbeddedViews(lView);

    // Content query results must be refreshed before content hooks are called.
    if (tView.contentQueries !== null) {
      refreshContentQueries(tView, lView);
    }

    // execute content hooks (AfterContentInit, AfterContentChecked)
    // PERF WARNING: do NOT extract this to a separate function without running benchmarks
    if (!isInCheckNoChangesPass) {
      if (hooksInitPhaseCompleted) {
        const contentCheckHooks = tView.contentCheckHooks;
        if (contentCheckHooks !== null) {
          executeCheckHooks(lView, contentCheckHooks);
        }
      } else {
        const contentHooks = tView.contentHooks;
        if (contentHooks !== null) {
          executeInitAndCheckHooks(
              lView, contentHooks, InitPhaseState.AfterContentInitHooksToBeRun);
        }
        incrementInitPhaseFlags(lView, InitPhaseState.AfterContentInitHooksToBeRun);
      }
    }

    processHostBindingOpCodes(tView, lView);

    // Refresh child component views.
    const components = tView.components;
    if (components !== null) {
      refreshChildComponents(lView, components);
    }

    // View queries must execute after refreshing child components because a template in this view
    // could be inserted in a child component. If the view query executes before child component
    // refresh, the template might not yet be inserted.
    const viewQuery = tView.viewQuery;
    if (viewQuery !== null) {
      executeViewQueryFn<T>(RenderFlags.Update, viewQuery, context);
    }

    // execute view hooks (AfterViewInit, AfterViewChecked)
    // PERF WARNING: do NOT extract this to a separate function without running benchmarks
    if (!isInCheckNoChangesPass) {
      if (hooksInitPhaseCompleted) {
        const viewCheckHooks = tView.viewCheckHooks;
        if (viewCheckHooks !== null) {
          executeCheckHooks(lView, viewCheckHooks);
        }
      } else {
        const viewHooks = tView.viewHooks;
        if (viewHooks !== null) {
          executeInitAndCheckHooks(lView, viewHooks, InitPhaseState.AfterViewInitHooksToBeRun);
        }
        incrementInitPhaseFlags(lView, InitPhaseState.AfterViewInitHooksToBeRun);
      }
    }
    if (tView.firstUpdatePass === true) {
      // We need to make sure that we only flip the flag on successful `refreshView` only
      // Don't do this in `finally` block.
      // If we did this in `finally` block then an exception could block the execution of styling
      // instructions which in turn would be unable to insert themselves into the styling linked
      // list. The result of this would be that if the exception would not be throw on subsequent CD
      // the styling would be unable to process it data and reflect to the DOM.
      tView.firstUpdatePass = false;
    }

    // Do not reset the dirty state when running in check no changes mode. We don't want components
    // to behave differently depending on whether check no changes is enabled or not. For example:
    // Marking an OnPush component as dirty from within the `ngAfterViewInit` hook in order to
    // refresh a `NgClass` binding should work. If we would reset the dirty state in the check
    // no changes cycle, the component would be not be dirty for the next update pass. This would
    // be different in production mode where the component dirty state is not reset.
    if (!isInCheckNoChangesPass) {
      lView[FLAGS] &= ~(LViewFlags.Dirty | LViewFlags.FirstLViewPass);
    }
    if (lView[FLAGS] & LViewFlags.RefreshTransplantedView) {
      lView[FLAGS] &= ~LViewFlags.RefreshTransplantedView;
      updateTransplantedViewCount(lView[PARENT] as LContainer, -1);
    }
  } finally {
    leaveView();
  }
}

function executeTemplate<T>(
    tView: TView, lView: LView<T>, templateFn: ComponentTemplate<T>, rf: RenderFlags, context: T) {
  const prevSelectedIndex = getSelectedIndex();
  const isUpdatePhase = rf & RenderFlags.Update;
  try {
    setSelectedIndex(-1);
    if (isUpdatePhase && lView.length > HEADER_OFFSET) {
      // When we're updating, inherently select 0 so we don't
      // have to generate that instruction for most update blocks.
      selectIndexInternal(tView, lView, HEADER_OFFSET, !!ngDevMode && isInCheckNoChangesMode());
    }

    const preHookType =
        isUpdatePhase ? ProfilerEvent.TemplateUpdateStart : ProfilerEvent.TemplateCreateStart;
    profiler(preHookType, context as unknown as {});
    templateFn(rf, context);
  } finally {
    setSelectedIndex(prevSelectedIndex);

    const postHookType =
        isUpdatePhase ? ProfilerEvent.TemplateUpdateEnd : ProfilerEvent.TemplateCreateEnd;
    profiler(postHookType, context as unknown as {});
  }
}

//////////////////////////
//// Element
//////////////////////////

export function executeContentQueries(tView: TView, tNode: TNode, lView: LView) {
  if (isContentQueryHost(tNode)) {
    const start = tNode.directiveStart;
    const end = tNode.directiveEnd;
    for (let directiveIndex = start; directiveIndex < end; directiveIndex++) {
      const def = tView.data[directiveIndex] as DirectiveDef<any>;
      if (def.contentQueries) {
        def.contentQueries(RenderFlags.Create, lView[directiveIndex], directiveIndex);
      }
    }
  }
}


/**
 * Creates directive instances.
 *
 * 创建指令实例。
 *
 */
export function createDirectivesInstances(tView: TView, lView: LView, tNode: TDirectiveHostNode) {
  if (!getBindingsEnabled()) return;
  instantiateAllDirectives(tView, lView, tNode, getNativeByTNode(tNode, lView));
  if ((tNode.flags & TNodeFlags.hasHostBindings) === TNodeFlags.hasHostBindings) {
    invokeDirectivesHostBindings(tView, lView, tNode);
  }
}

/**
 * Takes a list of local names and indices and pushes the resolved local variable values
 * to LView in the same order as they are loaded in the template with load().
 *
 * 获取本地名称和索引的列表，并按照使用 load() 在模板中加载它们的顺序将解析的局部变量值推送到
 * LView。
 *
 */
export function saveResolvedLocalsInData(
    viewData: LView, tNode: TDirectiveHostNode,
    localRefExtractor: LocalRefExtractor = getNativeByTNode): void {
  const localNames = tNode.localNames;
  if (localNames !== null) {
    let localIndex = tNode.index + 1;
    for (let i = 0; i < localNames.length; i += 2) {
      const index = localNames[i + 1] as number;
      const value = index === -1 ?
          localRefExtractor(
              tNode as TElementNode | TContainerNode | TElementContainerNode, viewData) :
          viewData[index];
      viewData[localIndex++] = value;
    }
  }
}

/**
 * Gets TView from a template function or creates a new TView
 * if it doesn't already exist.
 *
 * 从模板函数获取 TView ，如果不存在，则创建一个新的 TView。
 *
 * @param def ComponentDef
 *
 * 组件定义
 *
 * @returns
 *
 * TView
 *
 * 视图
 *
 */
export function getOrCreateComponentTView(def: ComponentDef<any>): TView {
  const tView = def.tView;

  // Create a TView if there isn't one, or recreate it if the first create pass didn't
  // complete successfully since we can't know for sure whether it's in a usable shape.
  if (tView === null || tView.incompleteFirstPass) {
    // Declaration node here is null since this function is called when we dynamically create a
    // component and hence there is no declaration.
    const declTNode = null;
    return def.tView = createTView(
               TViewType.Component, declTNode, def.template, def.decls, def.vars, def.directiveDefs,
               def.pipeDefs, def.viewQuery, def.schemas, def.consts);
  }

  return tView;
}


/**
 * Creates a TView instance
 *
 * 创建一个 TView 实例
 *
 * @param type Type of `TView`.
 *
 * `TView` 的类型。
 *
 * @param declTNode Declaration location of this `TView`.
 *
 * 此 `TView` 的声明位置。
 *
 * @param templateFn Template function
 *
 * 模板函数
 *
 * @param decls The number of nodes, local refs, and pipes in this template
 *
 * 此模板中的节点、本地引用和管道的数量
 *
 * @param directives Registry of directives for this view
 *
 * 此视图的指令注册表
 *
 * @param pipes Registry of pipes for this view
 *
 * 此视图的管道注册表
 *
 * @param viewQuery View queries for this view
 *
 * 此视图的视图查询
 *
 * @param schemas Schemas for this view
 *
 * 此视图的模式
 *
 * @param consts Constants for this view
 *
 * 此视图的常量
 *
 */
export function createTView(
    type: TViewType, declTNode: TNode|null, templateFn: ComponentTemplate<any>|null, decls: number,
    vars: number, directives: DirectiveDefListOrFactory|null, pipes: PipeDefListOrFactory|null,
    viewQuery: ViewQueriesFunction<any>|null, schemas: SchemaMetadata[]|null,
    constsOrFactory: TConstantsOrFactory|null): TView {
  ngDevMode && ngDevMode.tView++;
  const bindingStartIndex = HEADER_OFFSET + decls;
  // This length does not yet contain host bindings from child directives because at this point,
  // we don't know which directives are active on this template. As soon as a directive is matched
  // that has a host binding, we will update the blueprint with that def's hostVars count.
  const initialViewLength = bindingStartIndex + vars;
  const blueprint = createViewBlueprint(bindingStartIndex, initialViewLength);
  const consts = typeof constsOrFactory === 'function' ? constsOrFactory() : constsOrFactory;
  const tView = blueprint[TVIEW as any] = ngDevMode ?
      new TViewConstructor(
          type,        // type: TViewType,
          blueprint,   // blueprint: LView,
          templateFn,  // template: ComponentTemplate<{}>|null,
          null,        // queries: TQueries|null
          viewQuery,   // viewQuery: ViewQueriesFunction<{}>|null,
          declTNode,   // declTNode: TNode|null,
          cloneToTViewData(blueprint).fill(null, bindingStartIndex),  // data: TData,
          bindingStartIndex,                                          // bindingStartIndex: number,
          initialViewLength,                                          // expandoStartIndex: number,
          null,                               // hostBindingOpCodes: HostBindingOpCodes,
          true,                               // firstCreatePass: boolean,
          true,                               // firstUpdatePass: boolean,
          false,                              // staticViewQueries: boolean,
          false,                              // staticContentQueries: boolean,
          null,                               // preOrderHooks: HookData|null,
          null,                               // preOrderCheckHooks: HookData|null,
          null,                               // contentHooks: HookData|null,
          null,                               // contentCheckHooks: HookData|null,
          null,                               // viewHooks: HookData|null,
          null,                               // viewCheckHooks: HookData|null,
          null,                               // destroyHooks: DestroyHookData|null,
          null,                               // cleanup: any[]|null,
          null,                               // contentQueries: number[]|null,
          null,                               // components: number[]|null,
          typeof directives === 'function' ?  //
              directives() :                  //
              directives,                     // directiveRegistry: DirectiveDefList|null,
          typeof pipes === 'function' ? pipes() : pipes,  // pipeRegistry: PipeDefList|null,
          null,                                           // firstChild: TNode|null,
          schemas,                                        // schemas: SchemaMetadata[]|null,
          consts,                                         // consts: TConstants|null
          false,                                          // incompleteFirstPass: boolean
          decls,                                          // ngDevMode only: decls
          vars,                                           // ngDevMode only: vars
          ) :
      {
        type: type,
        blueprint: blueprint,
        template: templateFn,
        queries: null,
        viewQuery: viewQuery,
        declTNode: declTNode,
        data: blueprint.slice().fill(null, bindingStartIndex),
        bindingStartIndex: bindingStartIndex,
        expandoStartIndex: initialViewLength,
        hostBindingOpCodes: null,
        firstCreatePass: true,
        firstUpdatePass: true,
        staticViewQueries: false,
        staticContentQueries: false,
        preOrderHooks: null,
        preOrderCheckHooks: null,
        contentHooks: null,
        contentCheckHooks: null,
        viewHooks: null,
        viewCheckHooks: null,
        destroyHooks: null,
        cleanup: null,
        contentQueries: null,
        components: null,
        directiveRegistry: typeof directives === 'function' ? directives() : directives,
        pipeRegistry: typeof pipes === 'function' ? pipes() : pipes,
        firstChild: null,
        schemas: schemas,
        consts: consts,
        incompleteFirstPass: false
      };
  if (ngDevMode) {
    // For performance reasons it is important that the tView retains the same shape during runtime.
    // (To make sure that all of the code is monomorphic.) For this reason we seal the object to
    // prevent class transitions.
    Object.seal(tView);
  }
  return tView;
}

function createViewBlueprint(bindingStartIndex: number, initialViewLength: number): LView {
  const blueprint = ngDevMode ? new LViewBlueprint() : [];

  for (let i = 0; i < initialViewLength; i++) {
    blueprint.push(i < bindingStartIndex ? null : NO_CHANGE);
  }

  return blueprint as LView;
}

/**
 * Locates the host native element, used for bootstrapping existing nodes into rendering pipeline.
 *
 * 定位宿主本机元素，用于将现有节点引导到渲染管道。
 *
 * @param rendererFactory Factory function to create renderer instance.
 *
 * 用于创建渲染器实例的工厂函数。
 *
 * @param elementOrSelector Render element or CSS selector to locate the element.
 *
 * 渲染元素或 CSS 选择器以定位元素。
 *
 * @param encapsulation View Encapsulation defined for component that requests host element.
 *
 * 为请求宿主元素的组件定义的视图封装。
 *
 */
export function locateHostElement(
    renderer: Renderer, elementOrSelector: RElement|string,
    encapsulation: ViewEncapsulation): RElement {
  // When using native Shadow DOM, do not clear host element to allow native slot projection
  const preserveContent = encapsulation === ViewEncapsulation.ShadowDom;
  return renderer.selectRootElement(elementOrSelector, preserveContent);
}

/**
 * Saves context for this cleanup function in LView.cleanupInstances.
 *
 * 在 LView.cleanupInstances 中保存此清理函数的上下文。
 *
 * On the first template pass, saves in TView:
 *
 * 在第一个模板传递中，保存在 TView 中：
 *
 * - Cleanup function
 *
 *   清理函数
 *
 * - Index of context we just saved in LView.cleanupInstances
 *
 *   我们刚刚保存在 LView.cleanupInstances 中的上下文索引
 *
 * This function can also be used to store instance specific cleanup fns. In that case the `context`
 * is `null` and the function is store in `LView` (rather than it `TView`).
 *
 * 此函数也可用于存储特定于实例的清理 fns。在这种情况下，`context` 为 `null` ，并且函数存储在
 * `LView`（而不是 `TView`）中。
 *
 */
export function storeCleanupWithContext(
    tView: TView, lView: LView, context: any, cleanupFn: Function): void {
  const lCleanup = getOrCreateLViewCleanup(lView);
  if (context === null) {
    // If context is null that this is instance specific callback. These callbacks can only be
    // inserted after template shared instances. For this reason in ngDevMode we freeze the TView.
    if (ngDevMode) {
      Object.freeze(getOrCreateTViewCleanup(tView));
    }
    lCleanup.push(cleanupFn);
  } else {
    lCleanup.push(context);

    if (tView.firstCreatePass) {
      getOrCreateTViewCleanup(tView).push(cleanupFn, lCleanup.length - 1);
    }
  }
}

/**
 * Constructs a TNode object from the arguments.
 *
 * 从参数构造一个 TNode 对象。
 *
 * @param tView `TView` to which this `TNode` belongs (used only in `ngDevMode`)
 *
 * 此 `TView` 所属的 `TNode`（仅在 `ngDevMode` 中使用）
 *
 * @param tParent Parent `TNode`
 *
 * 父 `TNode`
 *
 * @param type The type of the node
 *
 * 节点的类型
 *
 * @param index The index of the TNode in TView.data, adjusted for HEADER_OFFSET
 *
 * TView.data 中 TNode 的索引，已针对 HEADER_OFFSET 进行了调整
 *
 * @param tagName The tag name of the node
 *
 * 节点的标签名称
 *
 * @param attrs The attributes defined on this node
 *
 * 在此节点上定义的属性
 *
 * @param tViews Any TViews attached to this node
 *
 * 附加到此节点的任何 TView
 *
 * @returns
 *
 * the TNode object
 *
 * TNode 对象
 *
 */
export function createTNode(
    tView: TView, tParent: TElementNode|TContainerNode|null, type: TNodeType.Container,
    index: number, tagName: string|null, attrs: TAttributes|null): TContainerNode;
export function createTNode(
    tView: TView, tParent: TElementNode|TContainerNode|null, type: TNodeType.Element|TNodeType.Text,
    index: number, tagName: string|null, attrs: TAttributes|null): TElementNode;
export function createTNode(
    tView: TView, tParent: TElementNode|TContainerNode|null, type: TNodeType.ElementContainer,
    index: number, tagName: string|null, attrs: TAttributes|null): TElementContainerNode;
export function createTNode(
    tView: TView, tParent: TElementNode|TContainerNode|null, type: TNodeType.Icu, index: number,
    tagName: string|null, attrs: TAttributes|null): TIcuContainerNode;
export function createTNode(
    tView: TView, tParent: TElementNode|TContainerNode|null, type: TNodeType.Projection,
    index: number, tagName: string|null, attrs: TAttributes|null): TProjectionNode;
export function createTNode(
    tView: TView, tParent: TElementNode|TContainerNode|null, type: TNodeType, index: number,
    tagName: string|null, attrs: TAttributes|null): TNode;
export function createTNode(
    tView: TView, tParent: TElementNode|TContainerNode|null, type: TNodeType, index: number,
    value: string|null, attrs: TAttributes|null): TNode {
  ngDevMode && index !== 0 &&  // 0 are bogus nodes and they are OK. See `createContainerRef` in
                               // `view_engine_compatibility` for additional context.
      assertGreaterThanOrEqual(index, HEADER_OFFSET, 'TNodes can\'t be in the LView header.');
  ngDevMode && assertNotSame(attrs, undefined, '\'undefined\' is not valid value for \'attrs\'');
  ngDevMode && ngDevMode.tNode++;
  ngDevMode && tParent && assertTNodeForTView(tParent, tView);
  let injectorIndex = tParent ? tParent.injectorIndex : -1;
  const tNode = ngDevMode ?
      new TNodeDebug(
          tView,          // tView_: TView
          type,           // type: TNodeType
          index,          // index: number
          null,           // insertBeforeIndex: null|-1|number|number[]
          injectorIndex,  // injectorIndex: number
          -1,             // componentOffset: number
          -1,             // directiveStart: number
          -1,             // directiveEnd: number
          -1,             // directiveStylingLast: number
          null,           // propertyBindings: number[]|null
          0,              // flags: TNodeFlags
          0,              // providerIndexes: TNodeProviderIndexes
          value,          // value: string|null
          attrs,          // attrs: (string|AttributeMarker|(string|SelectorFlags)[])[]|null
          null,           // mergedAttrs
          null,           // localNames: (string|number)[]|null
          undefined,      // initialInputs: (string[]|null)[]|null|undefined
          null,           // inputs: PropertyAliases|null
          null,           // outputs: PropertyAliases|null
          null,           // tViews: ITView|ITView[]|null
          null,           // next: ITNode|null
          null,           // projectionNext: ITNode|null
          null,           // child: ITNode|null
          tParent,        // parent: TElementNode|TContainerNode|null
          null,           // projection: number|(ITNode|RNode[])[]|null
          null,           // styles: string|null
          null,           // stylesWithoutHost: string|null
          undefined,      // residualStyles: string|null
          null,           // classes: string|null
          null,           // classesWithoutHost: string|null
          undefined,      // residualClasses: string|null
          0 as any,       // classBindings: TStylingRange;
          0 as any,       // styleBindings: TStylingRange;
          ) :
      {
        type,
        index,
        insertBeforeIndex: null,
        injectorIndex,
        directiveStart: -1,
        directiveEnd: -1,
        directiveStylingLast: -1,
        componentOffset: -1,
        propertyBindings: null,
        flags: 0,
        providerIndexes: 0,
        value: value,
        attrs: attrs,
        mergedAttrs: null,
        localNames: null,
        initialInputs: undefined,
        inputs: null,
        outputs: null,
        tViews: null,
        next: null,
        projectionNext: null,
        child: null,
        parent: tParent,
        projection: null,
        styles: null,
        stylesWithoutHost: null,
        residualStyles: undefined,
        classes: null,
        classesWithoutHost: null,
        residualClasses: undefined,
        classBindings: 0 as any,
        styleBindings: 0 as any,
      };
  if (ngDevMode) {
    // For performance reasons it is important that the tNode retains the same shape during runtime.
    // (To make sure that all of the code is monomorphic.) For this reason we seal the object to
    // prevent class transitions.
    Object.seal(tNode);
  }
  return tNode;
}

/**
 * Generates the `PropertyAliases` data structure from the provided input/output mapping.
 * @param aliasMap Input/output mapping from the directive definition.
 * @param directiveIndex Index of the directive.
 * @param propertyAliases Object in which to store the results.
 * @param hostDirectiveAliasMap Object used to alias or filter out properties for host directives.
 * If the mapping is provided, it'll act as an allowlist, as well as a mapping of what public
 * name inputs/outputs should be exposed under.
 */
function generatePropertyAliases(
    aliasMap: {[publicName: string]: string}, directiveIndex: number,
    propertyAliases: PropertyAliases|null,
    hostDirectiveAliasMap: HostDirectiveBindingMap|null): PropertyAliases|null {
  for (let publicName in aliasMap) {
    if (aliasMap.hasOwnProperty(publicName)) {
      propertyAliases = propertyAliases === null ? {} : propertyAliases;
      const internalName = aliasMap[publicName];

      // If there are no host directive mappings, we want to remap using the alias map from the
      // definition itself. If there is an alias map, it has two functions:
      // 1. It serves as an allowlist of bindings that are exposed by the host directives. Only the
      // ones inside the host directive map will be exposed on the host.
      // 2. The public name of the property is aliased using the host directive alias map, rather
      // than the alias map from the definition.
      if (hostDirectiveAliasMap === null) {
        addPropertyAlias(propertyAliases, directiveIndex, publicName, internalName);
      } else if (hostDirectiveAliasMap.hasOwnProperty(publicName)) {
        addPropertyAlias(
            propertyAliases, directiveIndex, hostDirectiveAliasMap[publicName], internalName);
      }
    }
  }
  return propertyAliases;
}

function addPropertyAlias(
    propertyAliases: PropertyAliases, directiveIndex: number, publicName: string,
    internalName: string) {
  if (propertyAliases.hasOwnProperty(publicName)) {
    propertyAliases[publicName].push(directiveIndex, internalName);
  } else {
    propertyAliases[publicName] = [directiveIndex, internalName];
  }
}

/**
 * Initializes data structures required to work with directive inputs and outputs.
 * Initialization is done for all directives matched on a given TNode.
 *
 * 初始化使用指令输入和输出所需的数据结构。会对给定 TNode 上匹配的所有指令进行初始化。
 *
 */
function initializeInputAndOutputAliases(
    tView: TView, tNode: TNode, hostDirectiveDefinitionMap: HostDirectiveDefs|null): void {
  ngDevMode && assertFirstCreatePass(tView);

  const start = tNode.directiveStart;
  const end = tNode.directiveEnd;
  const tViewData = tView.data;

  const tNodeAttrs = tNode.attrs;
  const inputsFromAttrs: InitialInputData = ngDevMode ? new TNodeInitialInputs() : [];
  let inputsStore: PropertyAliases|null = null;
  let outputsStore: PropertyAliases|null = null;

  for (let directiveIndex = start; directiveIndex < end; directiveIndex++) {
    const directiveDef = tViewData[directiveIndex] as DirectiveDef<any>;
    const aliasData =
        hostDirectiveDefinitionMap ? hostDirectiveDefinitionMap.get(directiveDef) : null;
    const aliasedInputs = aliasData ? aliasData.inputs : null;
    const aliasedOutputs = aliasData ? aliasData.outputs : null;

    inputsStore =
        generatePropertyAliases(directiveDef.inputs, directiveIndex, inputsStore, aliasedInputs);
    outputsStore =
        generatePropertyAliases(directiveDef.outputs, directiveIndex, outputsStore, aliasedOutputs);
    // Do not use unbound attributes as inputs to structural directives, since structural
    // directive inputs can only be set using microsyntax (e.g. `<div *dir="exp">`).
    // TODO(FW-1930): microsyntax expressions may also contain unbound/static attributes, which
    // should be set for inline templates.
    const initialInputs =
        (inputsStore !== null && tNodeAttrs !== null && !isInlineTemplate(tNode)) ?
        generateInitialInputs(inputsStore, directiveIndex, tNodeAttrs) :
        null;
    inputsFromAttrs.push(initialInputs);
  }

  if (inputsStore !== null) {
    if (inputsStore.hasOwnProperty('class')) {
      tNode.flags |= TNodeFlags.hasClassInput;
    }
    if (inputsStore.hasOwnProperty('style')) {
      tNode.flags |= TNodeFlags.hasStyleInput;
    }
  }

  tNode.initialInputs = inputsFromAttrs;
  tNode.inputs = inputsStore;
  tNode.outputs = outputsStore;
}

/**
 * Mapping between attributes names that don't correspond to their element property names.
 *
 * 与其元素属性名称不对应的属性名称之间的映射。
 *
 * Performance note: this function is written as a series of if checks (instead of, say, a property
 * object lookup) for performance reasons - the series of `if` checks seems to be the fastest way of
 * mapping property names. Do NOT change without benchmarking.
 *
 * 性能说明：出于性能原因，此函数被编写为一系列 if 检查（而不是例如属性对象查找）- 这一系列 `if`
 * 检查似乎是映射属性名称的最快方式。未经基准测试，请勿更改。
 *
 * Note: this mapping has to be kept in sync with the equally named mapping in the template
 * type-checking machinery of ngtsc.
 *
 * 注意：此映射必须与 ngtsc 的模板类型检查机制中的同名映射保持同步。
 *
 */
function mapPropName(name: string): string {
  if (name === 'class') return 'className';
  if (name === 'for') return 'htmlFor';
  if (name === 'formaction') return 'formAction';
  if (name === 'innerHtml') return 'innerHTML';
  if (name === 'readonly') return 'readOnly';
  if (name === 'tabindex') return 'tabIndex';
  return name;
}

export function elementPropertyInternal<T>(
    tView: TView, tNode: TNode, lView: LView, propName: string, value: T, renderer: Renderer,
    sanitizer: SanitizerFn|null|undefined, nativeOnly: boolean): void {
  ngDevMode && assertNotSame(value, NO_CHANGE as any, 'Incoming value should never be NO_CHANGE.');
  const element = getNativeByTNode(tNode, lView) as RElement | RComment;
  let inputData = tNode.inputs;
  let dataValue: PropertyAliasValue|undefined;
  if (!nativeOnly && inputData != null && (dataValue = inputData[propName])) {
    setInputsForProperty(tView, lView, dataValue, propName, value);
    if (isComponentHost(tNode)) markDirtyIfOnPush(lView, tNode.index);
    if (ngDevMode) {
      setNgReflectProperties(lView, element, tNode.type, dataValue, value);
    }
  } else if (tNode.type & TNodeType.AnyRNode) {
    propName = mapPropName(propName);

    if (ngDevMode) {
      validateAgainstEventProperties(propName);
      if (!isPropertyValid(element, propName, tNode.value, tView.schemas)) {
        handleUnknownPropertyError(propName, tNode.value, tNode.type, lView);
      }
      ngDevMode.rendererSetProperty++;
    }

    // It is assumed that the sanitizer is only added when the compiler determines that the
    // property is risky, so sanitization can be done without further checks.
    value = sanitizer != null ? (sanitizer(value, tNode.value || '', propName) as any) : value;
    renderer.setProperty(element as RElement, propName, value);
  } else if (tNode.type & TNodeType.AnyContainer) {
    // If the node is a container and the property didn't
    // match any of the inputs or schemas we should throw.
    if (ngDevMode && !matchingSchemas(tView.schemas, tNode.value)) {
      handleUnknownPropertyError(propName, tNode.value, tNode.type, lView);
    }
  }
}

/**
 * If node is an OnPush component, marks its LView dirty.
 *
 * 如果 node 是 OnPush 组件，则将其 LView 标记为脏。
 *
 */
export function markDirtyIfOnPush(lView: LView, viewIndex: number): void {
  ngDevMode && assertLView(lView);
  const childComponentLView = getComponentLViewByIndex(viewIndex, lView);
  if (!(childComponentLView[FLAGS] & LViewFlags.CheckAlways)) {
    childComponentLView[FLAGS] |= LViewFlags.Dirty;
  }
}

function setNgReflectProperty(
    lView: LView, element: RElement|RComment, type: TNodeType, attrName: string, value: any) {
  const renderer = lView[RENDERER];
  attrName = normalizeDebugBindingName(attrName);
  const debugValue = normalizeDebugBindingValue(value);
  if (type & TNodeType.AnyRNode) {
    if (value == null) {
      renderer.removeAttribute((element as RElement), attrName);
    } else {
      renderer.setAttribute((element as RElement), attrName, debugValue);
    }
  } else {
    const textContent =
        escapeCommentText(`bindings=${JSON.stringify({[attrName]: debugValue}, null, 2)}`);
    renderer.setValue((element as RComment), textContent);
  }
}

export function setNgReflectProperties(
    lView: LView, element: RElement|RComment, type: TNodeType, dataValue: PropertyAliasValue,
    value: any) {
  if (type & (TNodeType.AnyRNode | TNodeType.Container)) {
    /**
     * dataValue is an array containing runtime input or output names for the directives:
     * i+0: directive instance index
     * i+1: privateName
     *
     * e.g. [0, 'change', 'change-minified']
     * we want to set the reflected property with the privateName: dataValue[i+1]
     */
    for (let i = 0; i < dataValue.length; i += 2) {
      setNgReflectProperty(lView, element, type, dataValue[i + 1] as string, value);
    }
  }
}

/**
 * Resolve the matched directives on a node.
 *
 * 解析节点上匹配的指令。
 *
 */
export function resolveDirectives(
    tView: TView, lView: LView, tNode: TElementNode|TContainerNode|TElementContainerNode,
    localRefs: string[]|null): boolean {
  // Please make sure to have explicit type for `exportsMap`. Inferred type triggers bug in
  // tsickle.
  ngDevMode && assertFirstCreatePass(tView);

  let hasDirectives = false;
  if (getBindingsEnabled()) {
    const exportsMap: ({[key: string]: number}|null) = localRefs === null ? null : {'': -1};
    const matchResult = findDirectiveDefMatches(tView, tNode);
    let directiveDefs: DirectiveDef<unknown>[]|null;
    let hostDirectiveDefs: HostDirectiveDefs|null;

    if (matchResult === null) {
      directiveDefs = hostDirectiveDefs = null;
    } else {
      [directiveDefs, hostDirectiveDefs] = matchResult;
    }

    if (directiveDefs !== null) {
      hasDirectives = true;
      initializeDirectives(tView, lView, tNode, directiveDefs, exportsMap, hostDirectiveDefs);
    }
    if (exportsMap) cacheMatchingLocalNames(tNode, localRefs, exportsMap);
  }
  // Merge the template attrs last so that they have the highest priority.
  tNode.mergedAttrs = mergeHostAttrs(tNode.mergedAttrs, tNode.attrs);
  return hasDirectives;
}

/** Initializes the data structures necessary for a list of directives to be instantiated. */
export function initializeDirectives(
    tView: TView, lView: LView<unknown>, tNode: TElementNode|TContainerNode|TElementContainerNode,
    directives: DirectiveDef<unknown>[], exportsMap: {[key: string]: number;}|null,
    hostDirectiveDefs: HostDirectiveDefs|null) {
  ngDevMode && assertFirstCreatePass(tView);

  // Publishes the directive types to DI so they can be injected. Needs to
  // happen in a separate pass before the TNode flags have been initialized.
  for (let i = 0; i < directives.length; i++) {
    diPublicInInjector(getOrCreateNodeInjectorForNode(tNode, lView), tView, directives[i].type);
  }

  initTNodeFlags(tNode, tView.data.length, directives.length);

  // When the same token is provided by several directives on the same node, some rules apply in
  // the viewEngine:
  // - viewProviders have priority over providers
  // - the last directive in NgModule.declarations has priority over the previous one
  // So to match these rules, the order in which providers are added in the arrays is very
  // important.
  for (let i = 0; i < directives.length; i++) {
    const def = directives[i];
    if (def.providersResolver) def.providersResolver(def);
  }
  let preOrderHooksFound = false;
  let preOrderCheckHooksFound = false;
  let directiveIdx = allocExpando(tView, lView, directives.length, null);
  ngDevMode &&
      assertSame(
          directiveIdx, tNode.directiveStart,
          'TNode.directiveStart should point to just allocated space');

  for (let i = 0; i < directives.length; i++) {
    const def = directives[i];
    // Merge the attrs in the order of matches. This assumes that the first directive is the
    // component itself, so that the component has the least priority.
    tNode.mergedAttrs = mergeHostAttrs(tNode.mergedAttrs, def.hostAttrs);

    configureViewWithDirective(tView, tNode, lView, directiveIdx, def);
    saveNameToExportMap(directiveIdx, def, exportsMap);

    if (def.contentQueries !== null) tNode.flags |= TNodeFlags.hasContentQuery;
    if (def.hostBindings !== null || def.hostAttrs !== null || def.hostVars !== 0)
      tNode.flags |= TNodeFlags.hasHostBindings;

    const lifeCycleHooks: OnChanges&OnInit&DoCheck = def.type.prototype;
    // Only push a node index into the preOrderHooks array if this is the first
    // pre-order hook found on this node.
    if (!preOrderHooksFound &&
        (lifeCycleHooks.ngOnChanges || lifeCycleHooks.ngOnInit || lifeCycleHooks.ngDoCheck)) {
      // We will push the actual hook function into this array later during dir instantiation.
      // We cannot do it now because we must ensure hooks are registered in the same
      // order that directives are created (i.e. injection order).
      (tView.preOrderHooks || (tView.preOrderHooks = [])).push(tNode.index);
      preOrderHooksFound = true;
    }

    if (!preOrderCheckHooksFound && (lifeCycleHooks.ngOnChanges || lifeCycleHooks.ngDoCheck)) {
      (tView.preOrderCheckHooks || (tView.preOrderCheckHooks = [])).push(tNode.index);
      preOrderCheckHooksFound = true;
    }

    directiveIdx++;
  }

  initializeInputAndOutputAliases(tView, tNode, hostDirectiveDefs);
}

/**
 * Add `hostBindings` to the `TView.hostBindingOpCodes`.
 *
 * 将 `hostBindings` 添加到 `TView.hostBindingOpCodes` 。
 *
 * @param tView `TView` to which the `hostBindings` should be added.
 *
 * 应添加 `TView` 的 `hostBindings` 。
 *
 * @param tNode `TNode` the element which contains the directive
 * @param directiveIdx Directive index in view.
 *
 * 视图中的指令索引。
 *
 * @param directiveVarsIdx Where will the directive's vars be stored
 *
 * 指令的 var 将存储在哪里
 *
 * @param def `ComponentDef`/`DirectiveDef`, which contains the `hostVars`/`hostBindings` to add.
 *
 * `ComponentDef` / `DirectiveDef` ，包含要添加的 `hostVars` / `hostBindings` 。
 *
 */
export function registerHostBindingOpCodes(
    tView: TView, tNode: TNode, directiveIdx: number, directiveVarsIdx: number,
    def: ComponentDef<any>|DirectiveDef<any>): void {
  ngDevMode && assertFirstCreatePass(tView);

  const hostBindings = def.hostBindings;
  if (hostBindings) {
    let hostBindingOpCodes = tView.hostBindingOpCodes;
    if (hostBindingOpCodes === null) {
      hostBindingOpCodes = tView.hostBindingOpCodes = [] as any as HostBindingOpCodes;
    }
    const elementIndx = ~tNode.index;
    if (lastSelectedElementIdx(hostBindingOpCodes) != elementIndx) {
      // Conditionally add select element so that we are more efficient in execution.
      // NOTE: this is strictly not necessary and it trades code size for runtime perf.
      // (We could just always add it.)
      hostBindingOpCodes.push(elementIndx);
    }
    hostBindingOpCodes.push(directiveIdx, directiveVarsIdx, hostBindings);
  }
}

/**
 * Returns the last selected element index in the `HostBindingOpCodes`
 *
 * 返回 `HostBindingOpCodes` 中最后选择的元素索引
 *
 * For perf reasons we don't need to update the selected element index in `HostBindingOpCodes` only
 * if it changes. This method returns the last index (or '0' if not found.)
 *
 * 出于 perf 的原因，我们不需要仅当 `HostBindingOpCodes`
 * 中的所选元素索引更改时才更新它。此方法返回最后一个索引（如果找不到，则返回“0”。）
 *
 * Selected element index are only the ones which are negative.
 *
 * 所选元素索引只是那些为负的。
 *
 */
function lastSelectedElementIdx(hostBindingOpCodes: HostBindingOpCodes): number {
  let i = hostBindingOpCodes.length;
  while (i > 0) {
    const value = hostBindingOpCodes[--i];
    if (typeof value === 'number' && value < 0) {
      return value;
    }
  }
  return 0;
}


/**
 * Instantiate all the directives that were previously resolved on the current node.
 *
 * 实例化以前在当前节点上解析的所有指令。
 *
 */
function instantiateAllDirectives(
    tView: TView, lView: LView, tNode: TDirectiveHostNode, native: RNode) {
  const start = tNode.directiveStart;
  const end = tNode.directiveEnd;
  if (!tView.firstCreatePass) {
    getOrCreateNodeInjectorForNode(tNode, lView);
  }

  attachPatchData(native, lView);

  const initialInputs = tNode.initialInputs;
  for (let i = start; i < end; i++) {
    const def = tView.data[i] as DirectiveDef<any>;
    const isComponent = isComponentDef(def);

    if (isComponent) {
      ngDevMode && assertTNodeType(tNode, TNodeType.AnyRNode);
      addComponentLogic(lView, tNode as TElementNode, def as ComponentDef<any>);
    }

    const directive = getNodeInjectable(lView, tView, i, tNode);
    attachPatchData(directive, lView);

    if (initialInputs !== null) {
      setInputsFromAttrs(lView, i - start, directive, def, tNode, initialInputs!);
    }

    if (isComponent) {
      const componentView = getComponentLViewByIndex(tNode.index, lView);
      componentView[CONTEXT] = directive;
    }
  }
}

export function invokeDirectivesHostBindings(tView: TView, lView: LView, tNode: TNode) {
  const start = tNode.directiveStart;
  const end = tNode.directiveEnd;
  const elementIndex = tNode.index;
  const currentDirectiveIndex = getCurrentDirectiveIndex();
  try {
    setSelectedIndex(elementIndex);
    for (let dirIndex = start; dirIndex < end; dirIndex++) {
      const def = tView.data[dirIndex] as DirectiveDef<unknown>;
      const directive = lView[dirIndex];
      setCurrentDirectiveIndex(dirIndex);
      if (def.hostBindings !== null || def.hostVars !== 0 || def.hostAttrs !== null) {
        invokeHostBindingsInCreationMode(def, directive);
      }
    }
  } finally {
    setSelectedIndex(-1);
    setCurrentDirectiveIndex(currentDirectiveIndex);
  }
}

/**
 * Invoke the host bindings in creation mode.
 *
 * 在创建模式下调用宿主绑定。
 *
 * @param def `DirectiveDef` which may contain the `hostBindings` function.
 *
 * `DirectiveDef` ，可能包含 `hostBindings` 函数。
 *
 * @param directive Instance of directive.
 *
 * 指令的实例。
 *
 */
export function invokeHostBindingsInCreationMode(def: DirectiveDef<any>, directive: any) {
  if (def.hostBindings !== null) {
    def.hostBindings!(RenderFlags.Create, directive);
  }
}

/**
 * Matches the current node against all available selectors.
 * If a component is matched (at most one), it is returned in first position in the array.
 *
 * 将当前节点与所有可用的选择器匹配。如果一个组件匹配（最多一个），则它会在数组中的第一个位置返回。
 *
 */
function findDirectiveDefMatches(
    tView: TView, tNode: TElementNode|TContainerNode|TElementContainerNode):
    [matches: DirectiveDef<unknown>[], hostDirectiveDefs: HostDirectiveDefs|null]|null {
  ngDevMode && assertFirstCreatePass(tView);
  ngDevMode && assertTNodeType(tNode, TNodeType.AnyRNode | TNodeType.AnyContainer);

  const registry = tView.directiveRegistry;
  let matches: DirectiveDef<unknown>[]|null = null;
  let hostDirectiveDefs: HostDirectiveDefs|null = null;
  if (registry) {
    for (let i = 0; i < registry.length; i++) {
      const def = registry[i] as ComponentDef<any>| DirectiveDef<any>;
      if (isNodeMatchingSelectorList(tNode, def.selectors!, /* isProjectionMode */ false)) {
        matches || (matches = ngDevMode ? new MatchesArray() : []);

        if (isComponentDef(def)) {
          if (ngDevMode) {
            assertTNodeType(
                tNode, TNodeType.Element,
                `"${tNode.value}" tags cannot be used as component hosts. ` +
                    `Please use a different tag to activate the ${stringify(def.type)} component.`);

            if (isComponentHost(tNode)) {
              throwMultipleComponentError(tNode, matches.find(isComponentDef)!.type, def.type);
            }
          }

          // Components are inserted at the front of the matches array so that their lifecycle
          // hooks run before any directive lifecycle hooks. This appears to be for ViewEngine
          // compatibility. This logic doesn't make sense with host directives, because it
          // would allow the host directives to undo any overrides the host may have made.
          // To handle this case, the host directives of components are inserted at the beginning
          // of the array, followed by the component. As such, the insertion order is as follows:
          // 1. Host directives belonging to the selector-matched component.
          // 2. Selector-matched component.
          // 3. Host directives belonging to selector-matched directives.
          // 4. Selector-matched directives.
          if (def.findHostDirectiveDefs !== null) {
            const hostDirectiveMatches: DirectiveDef<unknown>[] = [];
            hostDirectiveDefs = hostDirectiveDefs || new Map();
            def.findHostDirectiveDefs(def, hostDirectiveMatches, hostDirectiveDefs);
            // Add all host directives declared on this component, followed by the component itself.
            // Host directives should execute first so the host has a chance to override changes
            // to the DOM made by them.
            matches.unshift(...hostDirectiveMatches, def);
            // Component is offset starting from the beginning of the host directives array.
            const componentOffset = hostDirectiveMatches.length;
            markAsComponentHost(tView, tNode, componentOffset);
          } else {
            // No host directives on this component, just add the
            // component def to the beginning of the matches.
            matches.unshift(def);
            markAsComponentHost(tView, tNode, 0);
          }
        } else {
          // Append any host directives to the matches first.
          hostDirectiveDefs = hostDirectiveDefs || new Map();
          def.findHostDirectiveDefs?.(def, matches, hostDirectiveDefs);
          matches.push(def);
        }
      }
    }
  }
  return matches === null ? null : [matches, hostDirectiveDefs];
}

/**
 * Marks a given TNode as a component's host. This consists of:
 * - setting the component offset on the TNode.
 * - storing index of component's host element so it will be queued for view refresh during CD.
 *
 *   存储组件宿主元素的索引，以便在 CD 期间排队等待视图刷新。
 *
 */
export function markAsComponentHost(tView: TView, hostTNode: TNode, componentOffset: number): void {
  ngDevMode && assertFirstCreatePass(tView);
  ngDevMode && assertGreaterThan(componentOffset, -1, 'componentOffset must be great than -1');
  hostTNode.componentOffset = componentOffset;
  (tView.components || (tView.components = ngDevMode ? new TViewComponents() : []))
      .push(hostTNode.index);
}

/**
 * Caches local names and their matching directive indices for query and template lookups.
 *
 * 缓存本地名称及其匹配的指令索引以进行查询和模板查找。
 *
 */
function cacheMatchingLocalNames(
    tNode: TNode, localRefs: string[]|null, exportsMap: {[key: string]: number}): void {
  if (localRefs) {
    const localNames: (string|number)[] = tNode.localNames = ngDevMode ? new TNodeLocalNames() : [];

    // Local names must be stored in tNode in the same order that localRefs are defined
    // in the template to ensure the data is loaded in the same slots as their refs
    // in the template (for template queries).
    for (let i = 0; i < localRefs.length; i += 2) {
      const index = exportsMap[localRefs[i + 1]];
      if (index == null)
        throw new RuntimeError(
            RuntimeErrorCode.EXPORT_NOT_FOUND,
            ngDevMode && `Export of name '${localRefs[i + 1]}' not found!`);
      localNames.push(localRefs[i], index);
    }
  }
}

/**
 * Builds up an export map as directives are created, so local refs can be quickly mapped
 * to their directive instances.
 *
 * 在创建指令时构建导出映射表，因此本地引用可以快速映射到它们的指令实例。
 *
 */
function saveNameToExportMap(
    directiveIdx: number, def: DirectiveDef<any>|ComponentDef<any>,
    exportsMap: {[key: string]: number}|null) {
  if (exportsMap) {
    if (def.exportAs) {
      for (let i = 0; i < def.exportAs.length; i++) {
        exportsMap[def.exportAs[i]] = directiveIdx;
      }
    }
    if (isComponentDef(def)) exportsMap[''] = directiveIdx;
  }
}

/**
 * Initializes the flags on the current node, setting all indices to the initial index,
 * the directive count to 0, and adding the isComponent flag.
 *
 * 初始化当前节点上的标志，将所有索引设置为初始索引，指令 count 为 0，并添加 isComponent 标志。
 *
 * @param index the initial index
 *
 * 初始索引
 *
 */
export function initTNodeFlags(tNode: TNode, index: number, numberOfDirectives: number) {
  ngDevMode &&
      assertNotEqual(
          numberOfDirectives, tNode.directiveEnd - tNode.directiveStart,
          'Reached the max number of directives');
  tNode.flags |= TNodeFlags.isDirectiveHost;
  // When the first directive is created on a node, save the index
  tNode.directiveStart = index;
  tNode.directiveEnd = index + numberOfDirectives;
  tNode.providerIndexes = index;
}

/**
 * Setup directive for instantiation.
 *
 * 实例化的 Setup 指令。
 *
 * We need to create a `NodeInjectorFactory` which is then inserted in both the `Blueprint` as well
 * as `LView`. `TView` gets the `DirectiveDef`.
 *
 * 我们需要创建一个 `NodeInjectorFactory` ，然后将其插入到 `Blueprint` 和 `LView` 中。 `TView` 获取
 * `DirectiveDef` 。
 *
 * @param tView `TView`
 * @param tNode `TNode`
 * @param lView `LView`
 * @param directiveIndex Index where the directive will be stored in the Expando.
 *
 * 指令将在 Expando 中存储的索引。
 *
 * @param def `DirectiveDef`
 */
export function configureViewWithDirective<T>(
    tView: TView, tNode: TNode, lView: LView, directiveIndex: number, def: DirectiveDef<T>): void {
  ngDevMode &&
      assertGreaterThanOrEqual(directiveIndex, HEADER_OFFSET, 'Must be in Expando section');
  tView.data[directiveIndex] = def;
  const directiveFactory =
      def.factory || ((def as {factory: Function}).factory = getFactoryDef(def.type, true));
  // Even though `directiveFactory` will already be using `ɵɵdirectiveInject` in its generated code,
  // we also want to support `inject()` directly from the directive constructor context so we set
  // `ɵɵdirectiveInject` as the inject implementation here too.
  const nodeInjectorFactory =
      new NodeInjectorFactory(directiveFactory, isComponentDef(def), ɵɵdirectiveInject);
  tView.blueprint[directiveIndex] = nodeInjectorFactory;
  lView[directiveIndex] = nodeInjectorFactory;

  registerHostBindingOpCodes(
      tView, tNode, directiveIndex, allocExpando(tView, lView, def.hostVars, NO_CHANGE), def);
}

function addComponentLogic<T>(lView: LView, hostTNode: TElementNode, def: ComponentDef<T>): void {
  const native = getNativeByTNode(hostTNode, lView) as RElement;
  const tView = getOrCreateComponentTView(def);

  // Only component views should be added to the view tree directly. Embedded views are
  // accessed through their containers because they may be removed / re-added later.
  const rendererFactory = lView[RENDERER_FACTORY];
  const componentView = addToViewTree(
      lView,
      createLView(
          lView, tView, null, def.onPush ? LViewFlags.Dirty : LViewFlags.CheckAlways, native,
          hostTNode as TElementNode, rendererFactory, rendererFactory.createRenderer(native, def),
          null, null, null));

  // Component view will always be created before any injected LContainers,
  // so this is a regular element, wrap it with the component view
  lView[hostTNode.index] = componentView;
}

export function elementAttributeInternal(
    tNode: TNode, lView: LView, name: string, value: any, sanitizer: SanitizerFn|null|undefined,
    namespace: string|null|undefined) {
  if (ngDevMode) {
    assertNotSame(value, NO_CHANGE as any, 'Incoming value should never be NO_CHANGE.');
    validateAgainstEventAttributes(name);
    assertTNodeType(
        tNode, TNodeType.Element,
        `Attempted to set attribute \`${name}\` on a container node. ` +
            `Host bindings are not valid on ng-container or ng-template.`);
  }
  const element = getNativeByTNode(tNode, lView) as RElement;
  setElementAttribute(lView[RENDERER], element, namespace, tNode.value, name, value, sanitizer);
}

export function setElementAttribute(
    renderer: Renderer, element: RElement, namespace: string|null|undefined, tagName: string|null,
    name: string, value: any, sanitizer: SanitizerFn|null|undefined) {
  if (value == null) {
    ngDevMode && ngDevMode.rendererRemoveAttribute++;
    renderer.removeAttribute(element, name, namespace);
  } else {
    ngDevMode && ngDevMode.rendererSetAttribute++;
    const strValue =
        sanitizer == null ? renderStringify(value) : sanitizer(value, tagName || '', name);


    renderer.setAttribute(element, name, strValue as string, namespace);
  }
}

/**
 * Sets initial input properties on directive instances from attribute data
 *
 * 从属性数据在指令实例上设置初始输入属性
 *
 * @param lView Current LView that is being processed.
 *
 * 正在处理的当前 LView。
 *
 * @param directiveIndex Index of the directive in directives array
 *
 * 指令数组中的指令索引
 *
 * @param instance Instance of the directive on which to set the initial inputs
 *
 * 要设置初始输入的指令实例
 *
 * @param def The directive def that contains the list of inputs
 *
 * 包含输入列表的指令 def
 *
 * @param tNode The static data for this node
 *
 * 此节点的静态数据
 *
 */
function setInputsFromAttrs<T>(
    lView: LView, directiveIndex: number, instance: T, def: DirectiveDef<T>, tNode: TNode,
    initialInputData: InitialInputData): void {
  const initialInputs: InitialInputs|null = initialInputData![directiveIndex];
  if (initialInputs !== null) {
    const setInput = def.setInput;
    for (let i = 0; i < initialInputs.length;) {
      const publicName = initialInputs[i++];
      const privateName = initialInputs[i++];
      const value = initialInputs[i++];
      if (setInput !== null) {
        def.setInput!(instance, value, publicName, privateName);
      } else {
        (instance as any)[privateName] = value;
      }
      if (ngDevMode) {
        const nativeElement = getNativeByTNode(tNode, lView) as RElement;
        setNgReflectProperty(lView, nativeElement, tNode.type, privateName, value);
      }
    }
  }
}

/**
 * Generates initialInputData for a node and stores it in the template's static storage
 * so subsequent template invocations don't have to recalculate it.
 *
 * 为节点生成 initialInputData 并将其存储在模板的静态存储中，以便后续的模板调用不必重新计算它。
 *
 * initialInputData is an array containing values that need to be set as input properties
 * for directives on this node, but only once on creation. We need this array to support
 * the case where you set an @Input property of a directive using attribute-like syntax.
 * e.g. if you have a `name` @Input, you can set it once like this:
 *
 * initialInputData
 * 是一个数组，包含需要设置为此节点上指令的输入属性的值，但在创建时只有一次。我们需要此数组来支持你使用类属性语法设置指令的
 * @Input 属性的情况。例如，如果你有一个 `name` @Input ，你可以像这样设置它：
 *
 * <my-component name="Bess"></my-component>
 *
 * @param inputs Input alias map that was generated from the directive def inputs.
 * @param directiveIndex Index of the directive that is currently being processed.
 * @param attrs Static attrs on this node.
 */
function generateInitialInputs(
    inputs: PropertyAliases, directiveIndex: number, attrs: TAttributes): InitialInputs|null {
  let inputsToStore: InitialInputs|null = null;
  let i = 0;
  while (i < attrs.length) {
    const attrName = attrs[i];
    if (attrName === AttributeMarker.NamespaceURI) {
      // We do not allow inputs on namespaced attributes.
      i += 4;
      continue;
    } else if (attrName === AttributeMarker.ProjectAs) {
      // Skip over the `ngProjectAs` value.
      i += 2;
      continue;
    }

    // If we hit any other attribute markers, we're done anyway. None of those are valid inputs.
    if (typeof attrName === 'number') break;

    if (inputs.hasOwnProperty(attrName as string)) {
      if (inputsToStore === null) inputsToStore = [];

      // Find the input's public name from the input store. Note that we can be found easier
      // through the directive def, but we want to do it using the inputs store so that it can
      // account for host directive aliases.
      const inputConfig = inputs[attrName as string];
      for (let j = 0; j < inputConfig.length; j += 2) {
        if (inputConfig[j] === directiveIndex) {
          inputsToStore.push(
              attrName as string, inputConfig[j + 1] as string, attrs[i + 1] as string);
          // A directive can't have multiple inputs with the same name so we can break here.
          break;
        }
      }
    }

    i += 2;
  }
  return inputsToStore;
}

//////////////////////////
//// ViewContainer & View
//////////////////////////

// Not sure why I need to do `any` here but TS complains later.
const LContainerArray: any = class LContainer extends Array {};

/**
 * Creates a LContainer, either from a container instruction, or for a ViewContainerRef.
 *
 * 从容器指令或为 ViewContainerRef 创建 LContainer。
 *
 * @param hostNative The host element for the LContainer
 *
 * LContainer 的宿主元素
 *
 * @param hostTNode The host TNode for the LContainer
 *
 * LContainer 的宿主 TNode
 *
 * @param currentView The parent view of the LContainer
 *
 * LContainer 的父视图
 *
 * @param native The native comment element
 *
 * 原生注释元素
 *
 * @param isForViewContainerRef Optional a flag indicating the ViewContainerRef case
 *
 * 可选的标志
 *
 * @returns
 *
 * LContainer
 *
 * 大容器
 *
 */
export function createLContainer(
    hostNative: RElement|RComment|LView, currentView: LView, native: RComment,
    tNode: TNode): LContainer {
  ngDevMode && assertLView(currentView);
  // https://jsperf.com/array-literal-vs-new-array-really
  const lContainer: LContainer = new (ngDevMode ? LContainerArray : Array)(
      hostNative,   // host native
      true,         // Boolean `true` in this position signifies that this is an `LContainer`
      false,        // has transplanted views
      currentView,  // parent
      null,         // next
      0,            // transplanted views to refresh count
      tNode,        // t_host
      native,       // native,
      null,         // view refs
      null,         // moved views
  );
  ngDevMode &&
      assertEqual(
          lContainer.length, CONTAINER_HEADER_OFFSET,
          'Should allocate correct number of slots for LContainer header.');
  ngDevMode && attachLContainerDebug(lContainer);
  return lContainer;
}

/**
 * Goes over embedded views (ones created through ViewContainerRef APIs) and refreshes
 * them by executing an associated template function.
 *
 * 遍历嵌入式视图（通过 ViewContainerRef API 创建的视图）并通过执行关联的模板函数来刷新它们。
 *
 */
function refreshEmbeddedViews(lView: LView) {
  for (let lContainer = getFirstLContainer(lView); lContainer !== null;
       lContainer = getNextLContainer(lContainer)) {
    for (let i = CONTAINER_HEADER_OFFSET; i < lContainer.length; i++) {
      const embeddedLView = lContainer[i];
      const embeddedTView = embeddedLView[TVIEW];
      ngDevMode && assertDefined(embeddedTView, 'TView must be allocated');
      if (viewAttachedToChangeDetector(embeddedLView)) {
        refreshView(embeddedTView, embeddedLView, embeddedTView.template, embeddedLView[CONTEXT]!);
      }
    }
  }
}

/**
 * Mark transplanted views as needing to be refreshed at their insertion points.
 *
 * 将移植的视图标记为需要在其插入点刷新。
 *
 * @param lView The `LView` that may have transplanted views.
 *
 * 可能已移植视图的 `LView` 。
 *
 */
function markTransplantedViewsForRefresh(lView: LView) {
  for (let lContainer = getFirstLContainer(lView); lContainer !== null;
       lContainer = getNextLContainer(lContainer)) {
    if (!lContainer[HAS_TRANSPLANTED_VIEWS]) continue;

    const movedViews = lContainer[MOVED_VIEWS]!;
    ngDevMode && assertDefined(movedViews, 'Transplanted View flags set but missing MOVED_VIEWS');
    for (let i = 0; i < movedViews.length; i++) {
      const movedLView = movedViews[i]!;
      const insertionLContainer = movedLView[PARENT] as LContainer;
      ngDevMode && assertLContainer(insertionLContainer);
      // We don't want to increment the counter if the moved LView was already marked for
      // refresh.
      if ((movedLView[FLAGS] & LViewFlags.RefreshTransplantedView) === 0) {
        updateTransplantedViewCount(insertionLContainer, 1);
      }
      // Note, it is possible that the `movedViews` is tracking views that are transplanted *and*
      // those that aren't (declaration component === insertion component). In the latter case,
      // it's fine to add the flag, as we will clear it immediately in
      // `refreshEmbeddedViews` for the view currently being refreshed.
      movedLView[FLAGS] |= LViewFlags.RefreshTransplantedView;
    }
  }
}

/////////////

/**
 * Refreshes components by entering the component view and processing its bindings, queries, etc.
 *
 * 通过进入组件视图并处理其绑定、查询等来刷新组件。
 *
 * @param componentHostIdx  Element index in LView\[] (adjusted for HEADER_OFFSET)
 *
 * LView\[] 中的元素索引（已针对 HEADER_OFFSET 进行调整）
 *
 */
function refreshComponent(hostLView: LView, componentHostIdx: number): void {
  ngDevMode && assertEqual(isCreationMode(hostLView), false, 'Should be run in update mode');
  const componentView = getComponentLViewByIndex(componentHostIdx, hostLView);
  // Only attached components that are CheckAlways or OnPush and dirty should be refreshed
  if (viewAttachedToChangeDetector(componentView)) {
    const tView = componentView[TVIEW];
    if (componentView[FLAGS] & (LViewFlags.CheckAlways | LViewFlags.Dirty)) {
      refreshView(tView, componentView, tView.template, componentView[CONTEXT]);
    } else if (componentView[TRANSPLANTED_VIEWS_TO_REFRESH] > 0) {
      // Only attached components that are CheckAlways or OnPush and dirty should be refreshed
      refreshContainsDirtyView(componentView);
    }
  }
}

/**
 * Refreshes all transplanted views marked with `LViewFlags.RefreshTransplantedView` that are
 * children or descendants of the given lView.
 *
 * 刷新作为给定 lView 的子项或后代的 `LViewFlags.RefreshTransplantedView` 标记的所有移植视图。
 *
 * @param lView The lView which contains descendant transplanted views that need to be refreshed.
 *
 * 包含需要刷新的后代移植视图的 lView。
 *
 */
function refreshContainsDirtyView(lView: LView) {
  for (let lContainer = getFirstLContainer(lView); lContainer !== null;
       lContainer = getNextLContainer(lContainer)) {
    for (let i = CONTAINER_HEADER_OFFSET; i < lContainer.length; i++) {
      const embeddedLView = lContainer[i];
      if (viewAttachedToChangeDetector(embeddedLView)) {
        if (embeddedLView[FLAGS] & LViewFlags.RefreshTransplantedView) {
          const embeddedTView = embeddedLView[TVIEW];
          ngDevMode && assertDefined(embeddedTView, 'TView must be allocated');
          refreshView(
              embeddedTView, embeddedLView, embeddedTView.template, embeddedLView[CONTEXT]!);

        } else if (embeddedLView[TRANSPLANTED_VIEWS_TO_REFRESH] > 0) {
          refreshContainsDirtyView(embeddedLView);
        }
      }
    }
  }

  const tView = lView[TVIEW];
  // Refresh child component views.
  const components = tView.components;
  if (components !== null) {
    for (let i = 0; i < components.length; i++) {
      const componentView = getComponentLViewByIndex(components[i], lView);
      // Only attached components that are CheckAlways or OnPush and dirty should be refreshed
      if (viewAttachedToChangeDetector(componentView) &&
          componentView[TRANSPLANTED_VIEWS_TO_REFRESH] > 0) {
        refreshContainsDirtyView(componentView);
      }
    }
  }
}

function renderComponent(hostLView: LView, componentHostIdx: number) {
  ngDevMode && assertEqual(isCreationMode(hostLView), true, 'Should be run in creation mode');
  const componentView = getComponentLViewByIndex(componentHostIdx, hostLView);
  const componentTView = componentView[TVIEW];
  syncViewWithBlueprint(componentTView, componentView);
  renderView(componentTView, componentView, componentView[CONTEXT]);
}

/**
 * Syncs an LView instance with its blueprint if they have gotten out of sync.
 *
 * 如果 LView 实例不同步，则将它们与其蓝图同步。
 *
 * Typically, blueprints and their view instances should always be in sync, so the loop here
 * will be skipped. However, consider this case of two components side-by-side:
 *
 * 通常，蓝图及其视图实例应始终保持同步，因此将跳过这里的循环。但是，请考虑这种并排两个组件的情况：
 *
 * App template:
 *
 * 应用程序模板：
 *
 * ```
 * <comp></comp>
 * <comp></comp>
 * ```
 *
 * The following will happen:
 * 1\. App template begins processing.
 * 2\. First <comp> is matched as a component and its LView is created.
 * 3\. Second <comp> is matched as a component and its LView is created.
 * 4\. App template completes processing, so it's time to check child templates.
 * 5\. First <comp> template is checked. It has a directive, so its def is pushed to blueprint.
 * 6\. Second <comp> template is checked. Its blueprint has been updated by the first
 * <comp> template, but its LView was created before this update, so it is out of sync.
 *
 * 将发生以下情况： 1. 应用程序模板开始处理。 2.首先<comp>被作为组件匹配，并创建其 LView。 3.
 * 第二<comp>被作为组件匹配，并创建其 LView。 4.
 * 应用程序模板已完成处理，因此是时候检查子模板了。 5.第一个<comp>模板已检查。它有一个指令，因此其
 * def 被推送到蓝图。 6. 第二<comp>模板已检查。它的蓝图已由第一个更新<comp>模板，但其 LView
 * 是在此更新之前创建的，因此它不同步。
 *
 * Note that embedded views inside ngFor loops will never be out of sync because these views
 * are processed as soon as they are created.
 *
 * 请注意，ngFor 循环中的嵌入式视图永远不会不同步，因为这些视图是在创建后立即处理的。
 *
 * @param tView The `TView` that contains the blueprint for syncing
 *
 * 包含同步蓝图的 `TView`
 *
 * @param lView The view to sync
 *
 * 要同步的视图
 *
 */
function syncViewWithBlueprint(tView: TView, lView: LView) {
  for (let i = lView.length; i < tView.blueprint.length; i++) {
    lView.push(tView.blueprint[i]);
  }
}

/**
 * Adds LView or LContainer to the end of the current view tree.
 *
 * 将 LView 或 LContainer 添加到当前视图树的末尾。
 *
 * This structure will be used to traverse through nested views to remove listeners
 * and call onDestroy callbacks.
 *
 * 此结构将用于遍历嵌套视图以删除侦听器并调用 onDestroy 回调。
 *
 * @param lView The view where LView or LContainer should be added
 *
 * 应该添加 LView 或 LContainer 的视图
 *
 * @param adjustedHostIndex Index of the view's host node in LView\[], adjusted for header
 *
 * LView\[] 中视图宿主节点的索引，已针对标头进行调整
 *
 * @param lViewOrLContainer The LView or LContainer to add to the view tree
 *
 * 要添加到视图树的 LView 或 LContainer
 *
 * @returns
 *
 * The state passed in
 *
 * 传入的状态
 *
 */
export function addToViewTree<T extends LView|LContainer>(lView: LView, lViewOrLContainer: T): T {
  // TODO(benlesh/misko): This implementation is incorrect, because it always adds the LContainer
  // to the end of the queue, which means if the developer retrieves the LContainers from RNodes out
  // of order, the change detection will run out of order, as the act of retrieving the the
  // LContainer from the RNode is what adds it to the queue.
  if (lView[CHILD_HEAD]) {
    lView[CHILD_TAIL]![NEXT] = lViewOrLContainer;
  } else {
    lView[CHILD_HEAD] = lViewOrLContainer;
  }
  lView[CHILD_TAIL] = lViewOrLContainer;
  return lViewOrLContainer;
}

///////////////////////////////
//// Change detection
///////////////////////////////


/**
 * Marks current view and all ancestors dirty.
 *
 * 将当前视图和所有祖先标记为脏。
 *
 * Returns the root view because it is found as a byproduct of marking the view tree
 * dirty, and can be used by methods that consume markViewDirty() to easily schedule
 * change detection. Otherwise, such methods would need to traverse up the view tree
 * an additional time to get the root view and schedule a tick on it.
 *
 * 返回根视图，因为它是将视图树标记为脏的副产品，并且可以被使用 markViewDirty()
 * 的方法用来轻松安排变更检测。否则，此类方法将需要再次向上遍历视图树以获取根视图并在其上安排一个刻度。
 *
 * @param lView The starting LView to mark dirty
 *
 * 标记脏的启动 LView
 *
 * @returns
 *
 * the root LView
 *
 * 根 LView
 *
 */
export function markViewDirty(lView: LView): LView|null {
  while (lView) {
    lView[FLAGS] |= LViewFlags.Dirty;
    const parent = getLViewParent(lView);
    // Stop traversing up as soon as you find a root view that wasn't attached to any container
    if (isRootView(lView) && !parent) {
      return lView;
    }
    // continue otherwise
    lView = parent!;
  }
  return null;
}

export function detectChangesInternal<T>(
    tView: TView, lView: LView, context: T, notifyErrorHandler = true) {
  const rendererFactory = lView[RENDERER_FACTORY];

  // Check no changes mode is a dev only mode used to verify that bindings have not changed
  // since they were assigned. We do not want to invoke renderer factory functions in that mode
  // to avoid any possible side-effects.
  const checkNoChangesMode = !!ngDevMode && isInCheckNoChangesMode();

  if (!checkNoChangesMode && rendererFactory.begin) rendererFactory.begin();
  try {
    refreshView(tView, lView, tView.template, context);
  } catch (error) {
    if (notifyErrorHandler) {
      handleError(lView, error);
    }
    throw error;
  } finally {
    if (!checkNoChangesMode && rendererFactory.end) rendererFactory.end();
  }
}

export function checkNoChangesInternal<T>(
    tView: TView, lView: LView, context: T, notifyErrorHandler = true) {
  setIsInCheckNoChangesMode(true);
  try {
    detectChangesInternal(tView, lView, context, notifyErrorHandler);
  } finally {
    setIsInCheckNoChangesMode(false);
  }
}

function executeViewQueryFn<T>(
    flags: RenderFlags, viewQueryFn: ViewQueriesFunction<T>, component: T): void {
  ngDevMode && assertDefined(viewQueryFn, 'View queries function to execute must be defined.');
  setCurrentQueryIndex(0);
  viewQueryFn(flags, component);
}

///////////////////////////////
//// Bindings & interpolations
///////////////////////////////

/**
 * Stores meta-data for a property binding to be used by TestBed's `DebugElement.properties`.
 *
 * 存储 TestBed 的 `DebugElement.properties` 使用的属性绑定的元数据。
 *
 * In order to support TestBed's `DebugElement.properties` we need to save, for each binding:
 *
 * 为了支持 TestBed 的 `DebugElement.properties` ，我们需要为每个绑定保存：
 *
 * - a bound property name;
 *
 *   绑定的属性名称；
 *
 * - a static parts of interpolated strings;
 *
 *   a 内插字符串的静态部分；
 *
 * A given property metadata is saved at the binding's index in the `TView.data` (in other words, a
 * property binding metadata will be stored in `TView.data` at the same index as a bound value in
 * `LView`). Metadata are represented as `INTERPOLATION_DELIMITER`-delimited string with the
 * following format:
 *
 * 给定的属性元数据会保存在 `TView.data` 中绑定的索引处（换句话说，属性绑定元数据将存储在
 * `TView.data` 中与 LView 中的绑定值相同的索引 `LView`）。元数据表示为具有以下格式的
 * `INTERPOLATION_DELIMITER` 分隔字符串：
 *
 * - `propertyName` for bound properties;
 *
 *   绑定 `propertyName` 的 propertyName ；
 *
 * - `propertyName�prefix�interpolation_static_part1�..interpolation_static_partN�suffix` for
 *   interpolated properties.
 *
 *   `propertyName�prefix�interpolation_static_part1�..interpolation_static_partN�suffix`
 * 的插值属性。
 *
 * @param tData `TData` where meta-data will be saved;
 *
 * 将保存元数据的 `TData` ；
 *
 * @param tNode `TNode` that is a target of the binding;
 *
 * 作为绑定目标的 `TNode` ；
 *
 * @param propertyName bound property name;
 *
 * 绑定的属性名称；
 *
 * @param bindingIndex binding index in `LView`
 *
 * `LView` 中的绑定索引
 *
 * @param interpolationParts static interpolation parts (for property interpolations)
 *
 * 静态插值部分（用于属性插值）
 *
 */
export function storePropertyBindingMetadata(
    tData: TData, tNode: TNode, propertyName: string, bindingIndex: number,
    ...interpolationParts: string[]) {
  // Binding meta-data are stored only the first time a given property instruction is processed.
  // Since we don't have a concept of the "first update pass" we need to check for presence of the
  // binding meta-data to decide if one should be stored (or if was stored already).
  if (tData[bindingIndex] === null) {
    if (tNode.inputs == null || !tNode.inputs[propertyName]) {
      const propBindingIdxs = tNode.propertyBindings || (tNode.propertyBindings = []);
      propBindingIdxs.push(bindingIndex);
      let bindingMetadata = propertyName;
      if (interpolationParts.length > 0) {
        bindingMetadata +=
            INTERPOLATION_DELIMITER + interpolationParts.join(INTERPOLATION_DELIMITER);
      }
      tData[bindingIndex] = bindingMetadata;
    }
  }
}

export function getOrCreateLViewCleanup(view: LView): any[] {
  // top level variables should not be exported for performance reasons (PERF_NOTES.md)
  return view[CLEANUP] || (view[CLEANUP] = ngDevMode ? new LCleanup() : []);
}

export function getOrCreateTViewCleanup(tView: TView): any[] {
  return tView.cleanup || (tView.cleanup = ngDevMode ? new TCleanup() : []);
}

/**
 * There are cases where the sub component's renderer needs to be included
 * instead of the current renderer (see the componentSyntheticHost\* instructions).
 *
 * 在某些情况下，需要包含子组件的渲染器而不是当前渲染器（请参阅 componentSyntheticHost\* 说明）。
 *
 */
export function loadComponentRenderer(
    currentDef: DirectiveDef<any>|null, tNode: TNode, lView: LView): Renderer {
  // TODO(FW-2043): the `currentDef` is null when host bindings are invoked while creating root
  // component (see packages/core/src/render3/component.ts). This is not consistent with the process
  // of creating inner components, when current directive index is available in the state. In order
  // to avoid relying on current def being `null` (thus special-casing root component creation), the
  // process of creating root component should be unified with the process of creating inner
  // components.
  if (currentDef === null || isComponentDef(currentDef)) {
    lView = unwrapLView(lView[tNode.index])!;
  }
  return lView[RENDERER];
}

/**
 * Handles an error thrown in an LView.
 *
 * 处理 LView 中抛出的错误。
 *
 */
export function handleError(lView: LView, error: any): void {
  const injector = lView[INJECTOR];
  const errorHandler = injector ? injector.get(ErrorHandler, null) : null;
  errorHandler && errorHandler.handleError(error);
}

/**
 * Set the inputs of directives at the current node to corresponding value.
 *
 * 将当前节点处指令的输入设置为相应的值。
 *
 * @param tView The current TView
 *
 * 当前的 TView
 *
 * @param lView the `LView` which contains the directives.
 *
 * 包含指令的 `LView` 。
 *
 * @param inputs mapping between the public "input" name and privately-known,
 *        possibly minified, property names to write to.
 *
 * 公共“输入”名称与要写入的秘密（可能是缩小的）属性名称之间的映射。
 *
 * @param value Value to set.
 *
 * 要设置的值。
 *
 */
export function setInputsForProperty(
    tView: TView, lView: LView, inputs: PropertyAliasValue, publicName: string, value: any): void {
  for (let i = 0; i < inputs.length;) {
    const index = inputs[i++] as number;
    const privateName = inputs[i++] as string;
    const instance = lView[index];
    ngDevMode && assertIndexInRange(lView, index);
    const def = tView.data[index] as DirectiveDef<any>;
    if (def.setInput !== null) {
      def.setInput!(instance, value, publicName, privateName);
    } else {
      instance[privateName] = value;
    }
  }
}

/**
 * Updates a text binding at a given index in a given LView.
 *
 * 更新给定 LView 中给定索引处的文本绑定。
 *
 */
export function textBindingInternal(lView: LView, index: number, value: string): void {
  ngDevMode && assertString(value, 'Value should be a string');
  ngDevMode && assertNotSame(value, NO_CHANGE as any, 'value should not be NO_CHANGE');
  ngDevMode && assertIndexInRange(lView, index);
  const element = getNativeByIndex(index, lView) as any as RText;
  ngDevMode && assertDefined(element, 'native element should exist');
  updateTextNode(lView[RENDERER], element, value);
}
