/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as i18n from '../../../i18n/i18n_ast';
import * as o from '../../../output/output_ast';
import {ParseLocation, ParseSourceSpan} from '../../../parse_util';

import {serializeIcuNode} from './icu_serializer';
import {formatI18nPlaceholderName} from './util';

export function createLocalizeStatements(
    variable: o.ReadVarExpr, message: i18n.Message,
    params: {[name: string]: o.Expression}): o.Statement[] {
  const {messageParts, placeHolders} = serializeI18nMessageForLocalize(message);
  const sourceSpan = getSourceSpan(message);
  const expressions = placeHolders.map(ph => params[ph.text]);
  const localizedString =
      o.localizedString(message, messageParts, placeHolders, expressions, sourceSpan);
  const variableInitialization = variable.set(localizedString);
  return [new o.ExpressionStatement(variableInitialization)];
}

/**
 * This visitor walks over an i18n tree, capturing literal strings and placeholders.
 *
 * 此访问者走过一棵 i18n 树，捕获文字字符串和占位符。
 *
 * The result can be used for generating the `$localize` tagged template literals.
 *
 * 结果可用于生成 `$localize` 标记的模板文字。
 *
 */
class LocalizeSerializerVisitor implements i18n.Visitor {
  constructor(
      private placeholderToMessage: {[phName: string]: i18n.Message},
      private pieces: o.MessagePiece[]) {}

  visitText(text: i18n.Text): any {
    if (this.pieces[this.pieces.length - 1] instanceof o.LiteralPiece) {
      // Two literal pieces in a row means that there was some comment node in-between.
      this.pieces[this.pieces.length - 1].text += text.value;
    } else {
      const sourceSpan = new ParseSourceSpan(
          text.sourceSpan.fullStart, text.sourceSpan.end, text.sourceSpan.fullStart,
          text.sourceSpan.details);
      this.pieces.push(new o.LiteralPiece(text.value, sourceSpan));
    }
  }

  visitContainer(container: i18n.Container): any {
    container.children.forEach(child => child.visit(this));
  }

  visitIcu(icu: i18n.Icu): any {
    this.pieces.push(new o.LiteralPiece(serializeIcuNode(icu), icu.sourceSpan));
  }

  visitTagPlaceholder(ph: i18n.TagPlaceholder): any {
    this.pieces.push(
        this.createPlaceholderPiece(ph.startName, ph.startSourceSpan ?? ph.sourceSpan));
    if (!ph.isVoid) {
      ph.children.forEach(child => child.visit(this));
      this.pieces.push(
          this.createPlaceholderPiece(ph.closeName, ph.endSourceSpan ?? ph.sourceSpan));
    }
  }

  visitPlaceholder(ph: i18n.Placeholder): any {
    this.pieces.push(this.createPlaceholderPiece(ph.name, ph.sourceSpan));
  }

  visitIcuPlaceholder(ph: i18n.IcuPlaceholder): any {
    this.pieces.push(
        this.createPlaceholderPiece(ph.name, ph.sourceSpan, this.placeholderToMessage[ph.name]));
  }

  private createPlaceholderPiece(
      name: string, sourceSpan: ParseSourceSpan,
      associatedMessage?: i18n.Message): o.PlaceholderPiece {
    return new o.PlaceholderPiece(
        formatI18nPlaceholderName(name, /* useCamelCase */ false), sourceSpan, associatedMessage);
  }
}

/**
 * Serialize an i18n message into two arrays: messageParts and placeholders.
 *
 * 将 i18n 消息序列化为两个数组： messageParts 和占位符。
 *
 * These arrays will be used to generate `$localize` tagged template literals.
 *
 * 这些数组将用于生成 `$localize` 标记的模板文字。
 *
 * @param message The message to be serialized.
 *
 * 要序列化的消息。
 *
 * @returns
 *
 * an object containing the messageParts and placeholders.
 *
 * 包含 messageParts 和占位符的对象。
 *
 */
export function serializeI18nMessageForLocalize(message: i18n.Message):
    {messageParts: o.LiteralPiece[], placeHolders: o.PlaceholderPiece[]} {
  const pieces: o.MessagePiece[] = [];
  const serializerVisitor = new LocalizeSerializerVisitor(message.placeholderToMessage, pieces);
  message.nodes.forEach(node => node.visit(serializerVisitor));
  return processMessagePieces(pieces);
}

function getSourceSpan(message: i18n.Message): ParseSourceSpan {
  const startNode = message.nodes[0];
  const endNode = message.nodes[message.nodes.length - 1];
  return new ParseSourceSpan(
      startNode.sourceSpan.fullStart, endNode.sourceSpan.end, startNode.sourceSpan.fullStart,
      startNode.sourceSpan.details);
}

/**
 * Convert the list of serialized MessagePieces into two arrays.
 *
 * 将序列化 MessagePieces 列表转换为两个数组。
 *
 * One contains the literal string pieces and the other the placeholders that will be replaced by
 * expressions when rendering `$localize` tagged template literals.
 *
 * 一个包含文字字符串，另一个包含在呈现 `$localize` 标记的模板文字时将被表达式替换的占位符。
 *
 * @param pieces The pieces to process.
 *
 * 要处理的部分。
 *
 * @returns
 *
 * an object containing the messageParts and placeholders.
 *
 * 包含 messageParts 和占位符的对象。
 *
 */
function processMessagePieces(pieces: o.MessagePiece[]):
    {messageParts: o.LiteralPiece[], placeHolders: o.PlaceholderPiece[]} {
  const messageParts: o.LiteralPiece[] = [];
  const placeHolders: o.PlaceholderPiece[] = [];

  if (pieces[0] instanceof o.PlaceholderPiece) {
    // The first piece was a placeholder so we need to add an initial empty message part.
    messageParts.push(createEmptyMessagePart(pieces[0].sourceSpan.start));
  }

  for (let i = 0; i < pieces.length; i++) {
    const part = pieces[i];
    if (part instanceof o.LiteralPiece) {
      messageParts.push(part);
    } else {
      placeHolders.push(part);
      if (pieces[i - 1] instanceof o.PlaceholderPiece) {
        // There were two placeholders in a row, so we need to add an empty message part.
        messageParts.push(createEmptyMessagePart(pieces[i - 1].sourceSpan.end));
      }
    }
  }
  if (pieces[pieces.length - 1] instanceof o.PlaceholderPiece) {
    // The last piece was a placeholder so we need to add a final empty message part.
    messageParts.push(createEmptyMessagePart(pieces[pieces.length - 1].sourceSpan.end));
  }
  return {messageParts, placeHolders};
}

function createEmptyMessagePart(location: ParseLocation): o.LiteralPiece {
  return new o.LiteralPiece('', new ParseSourceSpan(location, location));
}
