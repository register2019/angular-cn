/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {AttributeMarker} from '../../core';
import {AST, ASTWithSource, BindingPipe, BindingType, EmptyExpr, Interpolation} from '../../expression_parser/ast';
import * as o from '../../output/output_ast';
import {ParseSourceSpan} from '../../parse_util';
import * as t from '../r3_ast';
import {Identifiers as R3} from '../r3_identifiers';

import {hyphenate, parse as parseStyle} from './style_parser';
import {ValueConverter} from './template';
import {DefinitionMap, getInterpolationArgsLength} from './util';

const IMPORTANT_FLAG = '!important';

/**
 * Minimum amount of binding slots required in the runtime for style/class bindings.
 *
 * 运行时中样式/类绑定所需的最小绑定槽量。
 *
 * Styling in Angular uses up two slots in the runtime LView/TData data structures to
 * record binding data, property information and metadata.
 *
 * Angular 中的样式设置会使用运行时 LView/TData
 * 数据结构中的两个插槽来记录绑定数据、属性信息和元数据。
 *
 * When a binding is registered it will place the following information in the `LView`:
 *
 * 注册绑定时，它将将以下信息放在 `LView` 中：
 *
 * slot 1) binding value
 * slot 2) cached value (all other values collected before it in string form)
 *
 * 插槽 1）绑定值插槽 2）缓存值（在它之前以字符串形式收集的所有其他值）
 *
 * When a binding is registered it will place the following information in the `TData`:
 *
 * 注册绑定时，它将将以下信息放在 `TData` 中：
 *
 * slot 1) prop name
 * slot 2) binding index that points to the previous style/class binding (and some extra config
 * values)
 *
 * 插槽 1）道具名称插槽 2）指向前一个样式/类绑定（以及一些额外的配置值）的绑定索引
 *
 * Let's imagine we have a binding that looks like so:
 *
 * 假设我们有一个看起来像这样的绑定：
 *
 * ```
 * <div [style.width]="x" [style.height]="y">
 * ```
 *
 * Our `LView` and `TData` data-structures look like so:
 *
 * 我们的 `LView` 和 `TData` 数据结构如下所示：
 *
 * ```typescript
 * LView = [
 *   // ...
 *   x, // value of x
 *   "width: x",
 *
 *   y, // value of y
 *   "width: x; height: y",
 *   // ...
 * ];
 *
 * TData = [
 *   // ...
 *   "width", // binding slot 20
 *   0,
 *
 *   "height",
 *   20,
 *   // ...
 * ];
 * ```
 *
 */
export const MIN_STYLING_BINDING_SLOTS_REQUIRED = 2;

/**
 * A styling expression summary that is to be processed by the compiler
 *
 * 要由编译器处理的样式表达式摘要
 *
 */
export interface StylingInstruction {
  reference: o.ExternalReference;
  /**
   * Calls to individual styling instructions. Used when chaining calls to the same instruction.
   *
   * 调用单个样式说明。在链接对同一条指令的调用时使用。
   *
   */
  calls: StylingInstructionCall[];
}

export interface StylingInstructionCall {
  sourceSpan: ParseSourceSpan|null;
  supportsInterpolation: boolean;
  allocateBindingSlots: number;
  params: ((convertFn: (value: any) => o.Expression | o.Expression[]) => o.Expression[]);
}

/**
 * An internal record of the input data for a styling binding
 *
 * 样式绑定的输入数据的内部记录
 *
 */
interface BoundStylingEntry {
  hasOverrideFlag: boolean;
  name: string|null;
  suffix: string|null;
  sourceSpan: ParseSourceSpan;
  value: AST;
}

/**
 * Produces creation/update instructions for all styling bindings (class and style)
 *
 * 为所有样式绑定（类和风格）生成创建/更新操作指南
 *
 * It also produces the creation instruction to register all initial styling values
 * (which are all the static class="..." and style="..." attribute values that exist
 * on an element within a template).
 *
 * 它还会生成创建指令来注册所有初始样式值（这是模板中元素上存在的所有 static class="..." 和
 * style="..." 属性值）。
 *
 * The builder class below handles producing instructions for the following cases:
 *
 * 下面的构建器类会处理针对以下情况的生成操作指南：
 *
 * - Static style/class attributes (style="..." and class="...")
 *
 *   静态样式/类属性（style="..." 和 class="..."）
 *
 * - Dynamic style/class map bindings ([style]="map" and [class]="map|string")
 *
 *   动态样式/类映射绑定（[style][style] ="map" 和[class][class] ="map|string"）
 *
 * - Dynamic style/class property bindings ([style.prop]="exp" and [class.name]="exp")
 *
 *   动态样式/类属性绑定（[style.prop][style.prop] ="exp" 和[class.name][class.name] ="exp"）
 *
 * Due to the complex relationship of all of these cases, the instructions generated
 * for these attributes/properties/bindings must be done so in the correct order. The
 * order which these must be generated is as follows:
 *
 * 由于所有这些情况下的复杂关系，为这些属性/属性/绑定生成的指令必须按正确的顺序完成。这些必须生成的顺序如下：
 *
 * if (createMode) {
 *   styling(...)
 * }
 * if (updateMode) {
 *   styleMap(...)
 *   classMap(...)
 *   styleProp(...)
 *   classProp(...)
 * }
 *
 * if (createMode) {Style(…) } if (updateMode) { styleMap(…) classMap(…) styleProp(…) classProp(…) }
 *
 * The creation/update methods within the builder class produce these instructions.
 *
 * 构建器类中的创建/更新方法会生成这些操作指南。
 *
 */
export class StylingBuilder {
  /**
   * Whether or not there are any static styling values present
   *
   * 是否存在任何静态样式值
   *
   */
  private _hasInitialValues = false;
  /**
   * Whether or not there are any styling bindings present
   *  (i.e. `[style]`, `[class]`, `[style.prop]` or `[class.name]`)
   *
   * 是否存在任何样式绑定（即 `[style]`、`[class]`、`[style.prop]` 或 `[class.name]`）
   *
   */
  public hasBindings = false;
  public hasBindingsWithPipes = false;

  /**
   * the input for [class] \(if it exists)
   *
   * [类][class]的输入（如果存在）
   *
   */
  private _classMapInput: BoundStylingEntry|null = null;
  /**
   * the input for [style] \(if it exists)
   *
   * [style][style]的输入（如果存在）
   *
   */
  private _styleMapInput: BoundStylingEntry|null = null;
  /**
   * an array of each [style.prop] input
   *
   * 每个[style.prop][style.prop]输入的数组
   *
   */
  private _singleStyleInputs: BoundStylingEntry[]|null = null;
  /**
   * an array of each [class.name] input
   *
   * 每个[class.name][class.name]输入的数组
   *
   */
  private _singleClassInputs: BoundStylingEntry[]|null = null;
  private _lastStylingInput: BoundStylingEntry|null = null;
  private _firstStylingInput: BoundStylingEntry|null = null;

  // maps are used instead of hash maps because a Map will
  // retain the ordering of the keys

  /**
   * Represents the location of each style binding in the template
   * (e.g. `<div [style.width]="w" [style.height]="h">` implies
   * that `width=0` and `height=1`)
   *
   * 表示模板中每个样式绑定的位置（例如 `<div [style.width]="w" [style.height]="h">` 意味着
   * `width=0` 和 `height=1`）
   *
   */
  private _stylesIndex = new Map<string, number>();

  /**
   * Represents the location of each class binding in the template
   * (e.g. `<div [class.big]="b" [class.hidden]="h">` implies
   * that `big=0` and `hidden=1`)
   *
   * 表示模板中每个类绑定的位置（例如 `<div [class.big]="b" [class.hidden]="h">` 意味着 `big=0` 和
   * `hidden=1`）
   *
   */
  private _classesIndex = new Map<string, number>();
  private _initialStyleValues: string[] = [];
  private _initialClassValues: string[] = [];

  constructor(private _directiveExpr: o.Expression|null) {}

  /**
   * Registers a given input to the styling builder to be later used when producing AOT code.
   *
   * 将给定的输入注册到样式构建器，以供以后生成 AOT 代码时使用。
   *
   * The code below will only accept the input if it is somehow tied to styling (whether it be
   * style/class bindings or static style/class attributes).
   *
   * 下面的代码仅在输入以某种方式与样式绑定（无论是样式/类绑定还是静态样式/类属性）时才接受输入。
   *
   */
  registerBoundInput(input: t.BoundAttribute): boolean {
    // [attr.style] or [attr.class] are skipped in the code below,
    // they should not be treated as styling-based bindings since
    // they are intended to be written directly to the attr and
    // will therefore skip all style/class resolution that is present
    // with style="", [style]="" and [style.prop]="", class="",
    // [class.prop]="". [class]="" assignments
    let binding: BoundStylingEntry|null = null;
    let name = input.name;
    switch (input.type) {
      case BindingType.Property:
        binding = this.registerInputBasedOnName(name, input.value, input.sourceSpan);
        break;
      case BindingType.Style:
        binding = this.registerStyleInput(name, false, input.value, input.sourceSpan, input.unit);
        break;
      case BindingType.Class:
        binding = this.registerClassInput(name, false, input.value, input.sourceSpan);
        break;
    }
    return binding ? true : false;
  }

  registerInputBasedOnName(name: string, expression: AST, sourceSpan: ParseSourceSpan) {
    let binding: BoundStylingEntry|null = null;
    const prefix = name.substring(0, 6);
    const isStyle = name === 'style' || prefix === 'style.' || prefix === 'style!';
    const isClass = !isStyle && (name === 'class' || prefix === 'class.' || prefix === 'class!');
    if (isStyle || isClass) {
      const isMapBased = name.charAt(5) !== '.';        // style.prop or class.prop makes this a no
      const property = name.slice(isMapBased ? 5 : 6);  // the dot explains why there's a +1
      if (isStyle) {
        binding = this.registerStyleInput(property, isMapBased, expression, sourceSpan);
      } else {
        binding = this.registerClassInput(property, isMapBased, expression, sourceSpan);
      }
    }
    return binding;
  }

  registerStyleInput(
      name: string, isMapBased: boolean, value: AST, sourceSpan: ParseSourceSpan,
      suffix?: string|null): BoundStylingEntry|null {
    if (isEmptyExpression(value)) {
      return null;
    }
    // CSS custom properties are case-sensitive so we shouldn't normalize them.
    // See: https://www.w3.org/TR/css-variables-1/#defining-variables
    if (!isCssCustomProperty(name)) {
      name = hyphenate(name);
    }
    const {property, hasOverrideFlag, suffix: bindingSuffix} = parseProperty(name);
    suffix = typeof suffix === 'string' && suffix.length !== 0 ? suffix : bindingSuffix;
    const entry:
        BoundStylingEntry = {name: property, suffix: suffix, value, sourceSpan, hasOverrideFlag};
    if (isMapBased) {
      this._styleMapInput = entry;
    } else {
      (this._singleStyleInputs = this._singleStyleInputs || []).push(entry);
      registerIntoMap(this._stylesIndex, property);
    }
    this._lastStylingInput = entry;
    this._firstStylingInput = this._firstStylingInput || entry;
    this._checkForPipes(value);
    this.hasBindings = true;
    return entry;
  }

  registerClassInput(name: string, isMapBased: boolean, value: AST, sourceSpan: ParseSourceSpan):
      BoundStylingEntry|null {
    if (isEmptyExpression(value)) {
      return null;
    }
    const {property, hasOverrideFlag} = parseProperty(name);
    const entry:
        BoundStylingEntry = {name: property, value, sourceSpan, hasOverrideFlag, suffix: null};
    if (isMapBased) {
      this._classMapInput = entry;
    } else {
      (this._singleClassInputs = this._singleClassInputs || []).push(entry);
      registerIntoMap(this._classesIndex, property);
    }
    this._lastStylingInput = entry;
    this._firstStylingInput = this._firstStylingInput || entry;
    this._checkForPipes(value);
    this.hasBindings = true;
    return entry;
  }

  private _checkForPipes(value: AST) {
    if ((value instanceof ASTWithSource) && (value.ast instanceof BindingPipe)) {
      this.hasBindingsWithPipes = true;
    }
  }

  /**
   * Registers the element's static style string value to the builder.
   *
   * 将元素的静态样式字符串值注册到构建器。
   *
   * @param value the style string (e.g. `width:100px; height:200px;`)
   *
   * 样式字符串（例如 `width:100px; height:200px;`）
   *
   */
  registerStyleAttr(value: string) {
    this._initialStyleValues = parseStyle(value);
    this._hasInitialValues = true;
  }

  /**
   * Registers the element's static class string value to the builder.
   *
   * 将元素的静态类字符串值注册到构建器。
   *
   * @param value the className string (e.g. `disabled gold zoom`)
   *
   * className 字符串（例如 `disabled gold zoom`）
   *
   */
  registerClassAttr(value: string) {
    this._initialClassValues = value.trim().split(/\s+/g);
    this._hasInitialValues = true;
  }

  /**
   * Appends all styling-related expressions to the provided attrs array.
   *
   * 将所有与样式相关的表达式附加到提供的 attrs 数组。
   *
   * @param attrs an existing array where each of the styling expressions
   * will be inserted into.
   *
   * 将在其中插入每个样式表达式的现有数组。
   *
   */
  populateInitialStylingAttrs(attrs: o.Expression[]): void {
    // [CLASS_MARKER, 'foo', 'bar', 'baz' ...]
    if (this._initialClassValues.length) {
      attrs.push(o.literal(AttributeMarker.Classes));
      for (let i = 0; i < this._initialClassValues.length; i++) {
        attrs.push(o.literal(this._initialClassValues[i]));
      }
    }

    // [STYLE_MARKER, 'width', '200px', 'height', '100px', ...]
    if (this._initialStyleValues.length) {
      attrs.push(o.literal(AttributeMarker.Styles));
      for (let i = 0; i < this._initialStyleValues.length; i += 2) {
        attrs.push(
            o.literal(this._initialStyleValues[i]), o.literal(this._initialStyleValues[i + 1]));
      }
    }
  }

  /**
   * Builds an instruction with all the expressions and parameters for `elementHostAttrs`.
   *
   * 使用 `elementHostAttrs` 的所有表达式和参数构建指令。
   *
   * The instruction generation code below is used for producing the AOT statement code which is
   * responsible for registering initial styles (within a directive hostBindings' creation block),
   * as well as any of the provided attribute values, to the directive host element.
   *
   * 下面的指令生成代码用于生成 AOT 语句代码，该代码负责将初始样式（在指令 hostBindings
   * 的创建块中）以及提供的任何属性值注册到指令宿主元素。
   *
   */
  assignHostAttrs(attrs: o.Expression[], definitionMap: DefinitionMap): void {
    if (this._directiveExpr && (attrs.length || this._hasInitialValues)) {
      this.populateInitialStylingAttrs(attrs);
      definitionMap.set('hostAttrs', o.literalArr(attrs));
    }
  }

  /**
   * Builds an instruction with all the expressions and parameters for `classMap`.
   *
   * 使用 `classMap` 的所有表达式和参数构建指令。
   *
   * The instruction data will contain all expressions for `classMap` to function
   * which includes the `[class]` expression params.
   *
   * 指令数据将包含 `classMap` to function 的所有表达式，其中包括 `[class]` 表达式参数。
   *
   */
  buildClassMapInstruction(valueConverter: ValueConverter): StylingInstruction|null {
    if (this._classMapInput) {
      return this._buildMapBasedInstruction(valueConverter, true, this._classMapInput);
    }
    return null;
  }

  /**
   * Builds an instruction with all the expressions and parameters for `styleMap`.
   *
   * 使用 `styleMap` 的所有表达式和参数构建指令。
   *
   * The instruction data will contain all expressions for `styleMap` to function
   * which includes the `[style]` expression params.
   *
   * 指令数据将包含 `styleMap` to function 的所有表达式，其中包括 `[style]` 表达式参数。
   *
   */
  buildStyleMapInstruction(valueConverter: ValueConverter): StylingInstruction|null {
    if (this._styleMapInput) {
      return this._buildMapBasedInstruction(valueConverter, false, this._styleMapInput);
    }
    return null;
  }

  private _buildMapBasedInstruction(
      valueConverter: ValueConverter, isClassBased: boolean,
      stylingInput: BoundStylingEntry): StylingInstruction {
    // each styling binding value is stored in the LView
    // map-based bindings allocate two slots: one for the
    // previous binding value and another for the previous
    // className or style attribute value.
    let totalBindingSlotsRequired = MIN_STYLING_BINDING_SLOTS_REQUIRED;

    // these values must be outside of the update block so that they can
    // be evaluated (the AST visit call) during creation time so that any
    // pipes can be picked up in time before the template is built
    const mapValue = stylingInput.value.visit(valueConverter);
    let reference: o.ExternalReference;
    if (mapValue instanceof Interpolation) {
      totalBindingSlotsRequired += mapValue.expressions.length;
      reference = isClassBased ? getClassMapInterpolationExpression(mapValue) :
                                 getStyleMapInterpolationExpression(mapValue);
    } else {
      reference = isClassBased ? R3.classMap : R3.styleMap;
    }

    return {
      reference,
      calls: [{
        supportsInterpolation: true,
        sourceSpan: stylingInput.sourceSpan,
        allocateBindingSlots: totalBindingSlotsRequired,
        params: (convertFn: (value: any) => o.Expression|o.Expression[]) => {
          const convertResult = convertFn(mapValue);
          const params = Array.isArray(convertResult) ? convertResult : [convertResult];
          return params;
        }
      }]
    };
  }

  private _buildSingleInputs(
      reference: o.ExternalReference, inputs: BoundStylingEntry[], valueConverter: ValueConverter,
      getInterpolationExpressionFn: ((value: Interpolation) => o.ExternalReference)|null,
      isClassBased: boolean): StylingInstruction[] {
    const instructions: StylingInstruction[] = [];

    inputs.forEach(input => {
      const previousInstruction: StylingInstruction|undefined =
          instructions[instructions.length - 1];
      const value = input.value.visit(valueConverter);
      let referenceForCall = reference;

      // each styling binding value is stored in the LView
      // but there are two values stored for each binding:
      //   1) the value itself
      //   2) an intermediate value (concatenation of style up to this point).
      //      We need to store the intermediate value so that we don't allocate
      //      the strings on each CD.
      let totalBindingSlotsRequired = MIN_STYLING_BINDING_SLOTS_REQUIRED;

      if (value instanceof Interpolation) {
        totalBindingSlotsRequired += value.expressions.length;

        if (getInterpolationExpressionFn) {
          referenceForCall = getInterpolationExpressionFn(value);
        }
      }

      const call = {
        sourceSpan: input.sourceSpan,
        allocateBindingSlots: totalBindingSlotsRequired,
        supportsInterpolation: !!getInterpolationExpressionFn,
        params: (convertFn: (value: any) => o.Expression | o.Expression[]) => {
          // params => stylingProp(propName, value, suffix)
          const params: o.Expression[] = [];
          params.push(o.literal(input.name));

          const convertResult = convertFn(value);
          if (Array.isArray(convertResult)) {
            params.push(...convertResult);
          } else {
            params.push(convertResult);
          }

          // [style.prop] bindings may use suffix values (e.g. px, em, etc...), therefore,
          // if that is detected then we need to pass that in as an optional param.
          if (!isClassBased && input.suffix !== null) {
            params.push(o.literal(input.suffix));
          }

          return params;
        }
      };

      // If we ended up generating a call to the same instruction as the previous styling property
      // we can chain the calls together safely to save some bytes, otherwise we have to generate
      // a separate instruction call. This is primarily a concern with interpolation instructions
      // where we may start off with one `reference`, but end up using another based on the
      // number of interpolations.
      if (previousInstruction && previousInstruction.reference === referenceForCall) {
        previousInstruction.calls.push(call);
      } else {
        instructions.push({reference: referenceForCall, calls: [call]});
      }
    });

    return instructions;
  }

  private _buildClassInputs(valueConverter: ValueConverter): StylingInstruction[] {
    if (this._singleClassInputs) {
      return this._buildSingleInputs(
          R3.classProp, this._singleClassInputs, valueConverter, null, true);
    }
    return [];
  }

  private _buildStyleInputs(valueConverter: ValueConverter): StylingInstruction[] {
    if (this._singleStyleInputs) {
      return this._buildSingleInputs(
          R3.styleProp, this._singleStyleInputs, valueConverter,
          getStylePropInterpolationExpression, false);
    }
    return [];
  }

  /**
   * Constructs all instructions which contain the expressions that will be placed
   * into the update block of a template function or a directive hostBindings function.
   *
   * 构造包含将被放入模板函数或指令 hostBindings 函数的 update 块中的表达式的所有指令。
   *
   */
  buildUpdateLevelInstructions(valueConverter: ValueConverter) {
    const instructions: StylingInstruction[] = [];
    if (this.hasBindings) {
      const styleMapInstruction = this.buildStyleMapInstruction(valueConverter);
      if (styleMapInstruction) {
        instructions.push(styleMapInstruction);
      }
      const classMapInstruction = this.buildClassMapInstruction(valueConverter);
      if (classMapInstruction) {
        instructions.push(classMapInstruction);
      }
      instructions.push(...this._buildStyleInputs(valueConverter));
      instructions.push(...this._buildClassInputs(valueConverter));
    }
    return instructions;
  }
}

function registerIntoMap(map: Map<string, number>, key: string) {
  if (!map.has(key)) {
    map.set(key, map.size);
  }
}

export function parseProperty(name: string):
    {property: string, suffix: string|null, hasOverrideFlag: boolean} {
  let hasOverrideFlag = false;
  const overrideIndex = name.indexOf(IMPORTANT_FLAG);
  if (overrideIndex !== -1) {
    name = overrideIndex > 0 ? name.substring(0, overrideIndex) : '';
    hasOverrideFlag = true;
  }

  let suffix: string|null = null;
  let property = name;
  const unitIndex = name.lastIndexOf('.');
  if (unitIndex > 0) {
    suffix = name.slice(unitIndex + 1);
    property = name.substring(0, unitIndex);
  }

  return {property, suffix, hasOverrideFlag};
}

/**
 * Gets the instruction to generate for an interpolated class map.
 *
 * 获取要为插值类映射表生成的指令。
 *
 * @param interpolation An Interpolation AST
 *
 * 插值 AST
 *
 */
function getClassMapInterpolationExpression(interpolation: Interpolation): o.ExternalReference {
  switch (getInterpolationArgsLength(interpolation)) {
    case 1:
      return R3.classMap;
    case 3:
      return R3.classMapInterpolate1;
    case 5:
      return R3.classMapInterpolate2;
    case 7:
      return R3.classMapInterpolate3;
    case 9:
      return R3.classMapInterpolate4;
    case 11:
      return R3.classMapInterpolate5;
    case 13:
      return R3.classMapInterpolate6;
    case 15:
      return R3.classMapInterpolate7;
    case 17:
      return R3.classMapInterpolate8;
    default:
      return R3.classMapInterpolateV;
  }
}

/**
 * Gets the instruction to generate for an interpolated style map.
 *
 * 获取要为内插样式映射表生成的指令。
 *
 * @param interpolation An Interpolation AST
 *
 * 插值 AST
 *
 */
function getStyleMapInterpolationExpression(interpolation: Interpolation): o.ExternalReference {
  switch (getInterpolationArgsLength(interpolation)) {
    case 1:
      return R3.styleMap;
    case 3:
      return R3.styleMapInterpolate1;
    case 5:
      return R3.styleMapInterpolate2;
    case 7:
      return R3.styleMapInterpolate3;
    case 9:
      return R3.styleMapInterpolate4;
    case 11:
      return R3.styleMapInterpolate5;
    case 13:
      return R3.styleMapInterpolate6;
    case 15:
      return R3.styleMapInterpolate7;
    case 17:
      return R3.styleMapInterpolate8;
    default:
      return R3.styleMapInterpolateV;
  }
}

/**
 * Gets the instruction to generate for an interpolated style prop.
 *
 * 获取要为内插样式道具生成的指令。
 *
 * @param interpolation An Interpolation AST
 *
 * 插值 AST
 *
 */
function getStylePropInterpolationExpression(interpolation: Interpolation) {
  switch (getInterpolationArgsLength(interpolation)) {
    case 1:
      return R3.styleProp;
    case 3:
      return R3.stylePropInterpolate1;
    case 5:
      return R3.stylePropInterpolate2;
    case 7:
      return R3.stylePropInterpolate3;
    case 9:
      return R3.stylePropInterpolate4;
    case 11:
      return R3.stylePropInterpolate5;
    case 13:
      return R3.stylePropInterpolate6;
    case 15:
      return R3.stylePropInterpolate7;
    case 17:
      return R3.stylePropInterpolate8;
    default:
      return R3.stylePropInterpolateV;
  }
}

/**
 * Checks whether property name is a custom CSS property.
 * See: <https://www.w3.org/TR/css-variables-1>
 *
 * 检查属性名称是否是自定义 CSS 属性。请参阅： <https://www.w3.org/TR/css-variables-1>
 *
 */
function isCssCustomProperty(name: string): boolean {
  return name.startsWith('--');
}

function isEmptyExpression(ast: AST): boolean {
  if (ast instanceof ASTWithSource) {
    ast = ast.ast;
  }
  return ast instanceof EmptyExpr;
}
