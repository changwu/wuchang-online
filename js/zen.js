/* 右上角那句禅语
 *
 * 一页一句，自动往下翻：竖向滑动 + 淡出淡入，像翻书页。
 * 独立文件、纯展示，与语音链路（js/twin.js）完全解耦；
 * 这里任何异常都必须被吞掉，不能影响页面能不能用。
 */
(function () {
    "use strict";

    /* 短句优先：右上角空间有限，一行放得下才好看 */
    var QUOTES = [
        "日日是好日",
        "心安即是归处",
        "一期一会",
        "吃茶去",
        "花开有时",
        "慢慢来，比较快",
        "当下即是",
        "一步一景",
        "山不辞土",
        "守得云开见月明"
    ];

    var PAGE_MS = 8000;      /* 每页停留多久 */
    var FLIP_MS = 320;       /* 翻页动画时长 */
    var SLIDE = "62%";       /* 滑动距离（相对自身高度） */

    var host = null;
    var text = null;
    var timer = 0;
    var bag = [];            /* 洗牌袋：一轮之内不重复 */
    var reduceMotion = false;
    var flipping = false;

    function shuffled() {
        var a = QUOTES.slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = a[i];
            a[i] = a[j];
            a[j] = t;
        }
        return a;
    }

    function nextQuote() {
        if (!bag.length) { bag = shuffled(); }
        return bag.pop();
    }

    /* 阿昌正在说话时不翻页：那会儿用户的注意力在声音上 */
    function busy() {
        var state = (document.body && document.body.dataset.state) || "";
        return state === "talking";
    }

    function settle(q) {
        text.textContent = q;
        text.style.transition = "none";
        text.style.transform = "translateY(0)";
        text.style.opacity = "1";
        /* 省略号截断时，完整句子仍可从悬停提示读到 */
        if (host) { host.title = q; }
    }

    function flip() {
        if (!text || flipping) { return; }
        if (reduceMotion) {
            settle(nextQuote());
            return;
        }
        flipping = true;
        var ease = "cubic-bezier(0.33, 1, 0.68, 1)";
        text.style.transition = "transform " + FLIP_MS + "ms " + ease +
            ", opacity " + FLIP_MS + "ms " + ease;
        text.style.transform = "translateY(-" + SLIDE + ")";
        text.style.opacity = "0";

        window.setTimeout(function () {
            if (!text) { flipping = false; return; }
            settle(nextQuote());
            /* 从下方滑入前先归位到下方，再强制回流，否则浏览器会合并成一次跳变 */
            text.style.transition = "none";
            text.style.transform = "translateY(" + SLIDE + ")";
            text.style.opacity = "0";
            void text.offsetHeight;
            text.style.transition = "transform " + FLIP_MS + "ms " + ease +
                ", opacity " + FLIP_MS + "ms " + ease;
            text.style.transform = "translateY(0)";
            text.style.opacity = "1";
            window.setTimeout(function () { flipping = false; }, FLIP_MS);
        }, FLIP_MS);
    }

    function tick() {
        if (document.hidden || busy()) { return; }
        flip();
    }

    function start() {
        host = document.getElementById("zen");
        text = document.getElementById("zenText");
        if (!host || !text) { return; }

        try {
            reduceMotion = !!(window.matchMedia &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        } catch (e) {
            reduceMotion = false;
        }

        bag = shuffled();
        settle(bag.pop());
        timer = window.setInterval(tick, PAGE_MS);

        /* 从后台切回来时立刻换一页，避免看到一句停很久的旧话 */
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden && !busy()) { flip(); }
        });
    }

    function guard(fn) {
        return function () {
            try { fn(); } catch (e) { /* 禅语坏了也不能影响主页面 */ }
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", guard(start), { once: true });
    } else {
        guard(start)();
    }
})();
