/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {AbsoluteFsPath, ReadonlyFileSystem} from '@angular/compiler-cli/private/localize';

import {DiagnosticHandlingStrategy, Diagnostics} from '../../diagnostics';
import {TranslationBundle} from '../translator';

import {ParseAnalysis, TranslationParser} from './translation_parsers/translation_parser';

/**
 * Use this class to load a collection of translation files from disk.
 *
 * 使用此类从磁盘加载翻译文件的集合。
 *
 */
export class TranslationLoader {
  constructor(
      private fs: ReadonlyFileSystem, private translationParsers: TranslationParser<any>[],
      private duplicateTranslation: DiagnosticHandlingStrategy,
      /** @deprecated */ private diagnostics?: Diagnostics) {}

  /**
   * Load and parse the translation files into a collection of `TranslationBundles`.
   *
   * 加载翻译文件并将其解析到 `TranslationBundles` 的集合中。
   *
   * @param translationFilePaths An array, per locale, of absolute paths to translation files.
   *
   * 每个区域设置的翻译文件绝对路径的数组。
   *
   * For each locale to be translated, there is an element in `translationFilePaths`. Each element
   * is an array of absolute paths to translation files for that locale.
   * If the array contains more than one translation file, then the translations are merged.
   * If allowed by the `duplicateTranslation` property, when more than one translation has the same
   * message id, the message from the earlier translation file in the array is used.
   * For example, if the files are `[app.xlf, lib-1.xlf, lib-2.xlif]` then a message that appears in
   * `app.xlf` will override the same message in `lib-1.xlf` or `lib-2.xlf`.
   *
   * 对于每个要翻译的区域设置，`translationFilePaths`
   * 中都有一个元素。每个元素都是该区域设置的翻译文件的绝对路径数组。如果数组包含多个翻译文件，则会合并这些翻译。如果
   * `duplicateTranslation` 属性允许，当多个翻译具有相同的消息 id
   * 时，会使用数组中靠前的翻译文件中的消息。例如，如果文件是 `[app.xlf, lib-1.xlf, lib-2.xlif]`
   * ，则出现在 `app.xlf` 中的消息将覆盖 `lib-1.xlf` 或 `lib-2.xlf` 中的同一消息.
   *
   * @param translationFileLocales An array of locales for each of the translation files.
   *
   * 每个翻译文件的区域设置数组。
   *
   * If there is a locale provided in `translationFileLocales` then this is used rather than a
   * locale extracted from the file itself.
   * If there is neither a provided locale nor a locale parsed from the file, then an error is
   * thrown.
   * If there are both a provided locale and a locale parsed from the file, and they are not the
   * same, then a warning is reported.
   *
   * 如果 `translationFileLocales`
   * 中提供了区域设置，则会使用此区域设置，而不是从文件本身提取的区域设置。如果既没有提供的区域设置，也没有从文件解析的区域设置，则会抛出错误。如果同时存在提供的区域设置和从文件解析的区域设置，并且它们不相同，则会报告警告。
   *
   */
  loadBundles(
      translationFilePaths: AbsoluteFsPath[][],
      translationFileLocales: (string|undefined)[]): TranslationBundle[] {
    return translationFilePaths.map((filePaths, index) => {
      const providedLocale = translationFileLocales[index];
      return this.mergeBundles(filePaths, providedLocale);
    });
  }

  /**
   * Load all the translations from the file at the given `filePath`.
   *
   * 从给定 `filePath` 的文件中加载所有翻译。
   *
   */
  private loadBundle(filePath: AbsoluteFsPath, providedLocale: string|undefined):
      TranslationBundle {
    const fileContents = this.fs.readFile(filePath);
    const unusedParsers = new Map<TranslationParser<any>, ParseAnalysis<any>>();
    for (const translationParser of this.translationParsers) {
      const result = translationParser.analyze(filePath, fileContents);
      if (!result.canParse) {
        unusedParsers.set(translationParser, result);
        continue;
      }

      const {locale: parsedLocale, translations, diagnostics} =
          translationParser.parse(filePath, fileContents, result.hint);
      if (diagnostics.hasErrors) {
        throw new Error(diagnostics.formatDiagnostics(
            `The translation file "${filePath}" could not be parsed.`));
      }

      const locale = providedLocale || parsedLocale;
      if (locale === undefined) {
        throw new Error(`The translation file "${
            filePath}" does not contain a target locale and no explicit locale was provided for this file.`);
      }

      if (parsedLocale !== undefined && providedLocale !== undefined &&
          parsedLocale !== providedLocale) {
        diagnostics.warn(
            `The provided locale "${providedLocale}" does not match the target locale "${
                parsedLocale}" found in the translation file "${filePath}".`);
      }

      // If we were passed a diagnostics object then copy the messages over to it.
      if (this.diagnostics) {
        this.diagnostics.merge(diagnostics);
      }

      return {locale, translations, diagnostics};
    }

    const diagnosticsMessages: string[] = [];
    for (const [parser, result] of unusedParsers.entries()) {
      diagnosticsMessages.push(result.diagnostics.formatDiagnostics(
          `\n${parser.constructor.name} cannot parse translation file.`));
    }
    throw new Error(
        `There is no "TranslationParser" that can parse this translation file: ${filePath}.` +
        diagnosticsMessages.join('\n'));
  }

  /**
   * There is more than one `filePath` for this locale, so load each as a bundle and then merge
   * them all together.
   *
   * 此区域设置有多个 `filePath` ，因此将每个都作为包加载，然后将它们合并在一起。
   *
   */
  private mergeBundles(filePaths: AbsoluteFsPath[], providedLocale: string|undefined):
      TranslationBundle {
    const bundles = filePaths.map(filePath => this.loadBundle(filePath, providedLocale));
    const bundle = bundles[0];
    for (let i = 1; i < bundles.length; i++) {
      const nextBundle = bundles[i];
      if (nextBundle.locale !== bundle.locale) {
        if (this.diagnostics) {
          const previousFiles = filePaths.slice(0, i).map(f => `"${f}"`).join(', ');
          this.diagnostics.warn(`When merging multiple translation files, the target locale "${
              nextBundle.locale}" found in "${filePaths[i]}" does not match the target locale "${
              bundle.locale}" found in earlier files [${previousFiles}].`);
        }
      }
      Object.keys(nextBundle.translations).forEach(messageId => {
        if (bundle.translations[messageId] !== undefined) {
          this.diagnostics?.add(
              this.duplicateTranslation,
              `Duplicate translations for message "${messageId}" when merging "${filePaths[i]}".`);
        } else {
          bundle.translations[messageId] = nextBundle.translations[messageId];
        }
      });
    }
    return bundle;
  }
}
