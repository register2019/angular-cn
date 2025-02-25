# Slow computations

# 慢速计算

On every change detection cycle, Angular synchronously:

在每个变更检测周期上，Angular 都会同步进行：

* Evaluates all template expressions in all components, unless specified otherwise, based on that each component's detection strategy

  除非另有指定，否则会根据每个组件的检测策略估算所有组件中的所有模板表达式

* Executes the `ngDoCheck`, `ngAfterContentChecked`, `ngAfterViewChecked`, and `ngOnChanges` lifecycle hooks.
  A single slow computation within a template or a lifecycle hook can slow down the entire change detection process because Angular runs the computations sequentially.

  执行 `ngDoCheck` 、 `ngAfterContentChecked` 、 `ngAfterViewChecked` 和 `ngOnChanges` 生命周期钩子。模板中的单个慢速计算或生命周期钩子可能会减慢整个变更检测过程，因为 Angular 会按顺序运行计算。

## Identifying slow computations

## 识别慢速计算

You can identify heavy computations with Angular DevTools’ profiler. In the performance timeline, click a bar to preview a particular change detection cycle. This displays a bar chart, which shows how long the framework spent in change detection for each component. When you click a component, you can preview how long Angular spent  evaluating its template and lifecycle hooks.

你可以用 Angular DevTools 的分析器来识别繁重的计算。在性能时间线中，单击一个栏以预览特定的变更检测周期。这将显示一个条形图，该图显示了框架在每个组件的变更检测上花了多长时间。当你点击一个组件时，你可以预览 Angular 花了多长时间来评估其模板和生命周期钩子。

<div class="lightbox">
  <img alt="Angular DevTools profiler preview showing slow computation" src="generated/images/guide/change-detection/slow-computations.png">

</div>

For example, in the preceding screenshot, the second recorded change detection cycle is selected. Angular spent over 573 ms on this cycle, with the most time spent in the `EmployeeListComponent`. In the details panel, you can see that Angular spent over 297 ms evaluating the template of the `EmployeeListComponent`.

比如，在上面的屏幕截图中，选择了所记录的第二个变更检测周期，其中 Angular 在这个周期花费了超过 573 毫秒，大部分时间都花在了 `EmployeeListComponent` 上。在详细信息面板中，你可以看到 Angular 花了超过 297 毫秒的时间来估算 `EmployeeListComponent` 的模板。

## Optimizing slow computations

## 优化慢速计算

Here are several techniques to remove slow computations:

有几种技术可以消除慢速计算：

* **Optimizing the underlying algorithm**. This is the recommended approach. If you can speed up the algorithm that is causing the problem, you can speed up the entire change detection mechanism.

  **优化底层算法**。这是推荐的方法。如果你可以加快导致问题的算法的速度，则可以加快整个变更检测机制。

* **Caching using pure pipes**. You can move the heavy computation to a pure [pipe](https://angular.io/guide/pipes). Angular reevaluates a pure pipe only if it detects that its inputs have changed, compared to the previous time Angular called it.

  **使用纯管道进行缓存**。你可以将繁重的计算移动到纯[管道](https://angular.io/guide/pipes)中。与 Angular 上一次调用它时相比，只有在检测到其输入发生更改时，Angular 才会重新估算纯管道。

* **Using memoization**. [Memoization](https://en.wikipedia.org/wiki/Memoization) is a similar technique to pure pipes, with the difference that pure pipes preserve only the last result from the computation where memoization could store multiple results.

  **使用记忆化（memoization）**。[记忆化](https://en.wikipedia.org/wiki/Memoization)是一种与纯管道类似的技术，不同之处在于纯管道仅保留计算中的最后一个结果，而记忆化可以存储多个结果。

* **Avoid repaints/reflows in lifecycle hooks**. Certain [operations](https://web.dev/avoid-large-complex-layouts-and-layout-thrashing/) cause the browser to either synchronously recalculate the layout of the page or re-render it. Since reflows and repaints are generally slow, you want to avoid performing them in every change detection cycle.

  **避免在生命周期钩子中触发重绘/回流**。某些[操作](https://web.dev/avoid-large-complex-layouts-and-layout-thrashing/)会导致浏览器同步重新计算页面布局或重新渲染它。由于回流和重绘通常很慢，因此你要避免在每个变更检测周期中都执行它们。

Pure pipes and memoization have different trade-offs. Pure pipes are an Angular built-in concept compared to memoization, which is a general software engineering practice for caching function results. The memory overhead of memoization could be significant if you invoke the heavy computation frequently with different arguments.

纯管道和记忆化有不同的权衡。与记忆化相比，纯管道是 Angular 的内置概念，记忆化是一种用于缓存函数结果的通用软件工程实践。如果你使用不同的参数频繁调用繁重的计算，则记忆化的内存开销可能会很大。

@reviewed 2022-05-04