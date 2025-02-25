/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {CldrData} from '../cldr-data';
import {generateBaseCurrencies} from '../locale-base-currencies';
import {generateLocale} from '../locale-file';

import {BASE_LOCALE} from './base-locale';

/**
 * Generates the base locale file and prints it to the stdout.
 *
 * 生成基本区域设置文件并将其打印到标准输出。
 *
 */
function main() {
  const cldrData = new CldrData();
  const baseLocaleData = cldrData.getLocaleData(BASE_LOCALE)!;
  const baseCurrencies = generateBaseCurrencies(baseLocaleData);

  process.stdout.write(generateLocale(BASE_LOCALE, baseLocaleData, baseCurrencies));
}

if (require.main === module) {
  main();
}
