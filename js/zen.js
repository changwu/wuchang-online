/* 一句禅语
 *
 * 首页底部那行小字：安静时慢慢换，说话时不打扰。
 * 独立文件、纯展示，与语音链路（js/twin.js）完全解耦；
 * 这里任何异常都必须被吞掉，不能影响页面能不能用。
 */
(function () {
    "use strict";

    /* 短句优先：一行放得下，不抢正文的注意力 */
    var QUOTES = [
        "日日是好日",
        "心安即是归处",
        "一期一会",
        "吃茶去",
        "花开有时，不必催促",
        "慢慢来，比较快",
        "当下即是",
        "一步一景，莫问前程",
        "山不辞土，故能成其高",
        "守得云开见月明"
    ];

    var INTERVAL_MS = 24000;   /* 24 秒换一句：够慢，不干扰 */
    var FADE_MS = 600;

    /* 通话中不轮换 —— 这些状态下页面上已经有其他动静 */
    var QUIET_STATES = {
        connecting: 1, listening: 1, hearing: 1, thinking: 1, talking: 1
    };

    var node = null;
    var timer = 0;
    var bag = [];          /* 洗牌袋：一轮之内不重复 */
    var reduceMotion = false;

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

    function busy() {
        var state = (document.body && document.body.dataset.state) || "";
        return !!QUIET_STATES[state];
    }

    function swap() {
        if (!node) { return; }
        if (reduceMotion) {
            node.textContent = nextQuote();
            return;
        }
        node.style.transition = "opacity " + FADE_MS + "ms ease";
        node.style.opacity = "0";
        window.setTimeout(function () {
            if (!node) { return; }
            node.textContent = nextQuote();
            node.style.opacity = "1";
        }, FADE_MS);
    }

    function tick() {
        if (document.hidden || busy()) { return; }
        swap();
    }

    function start() {
        node = document.getElementById("zen");
        if (!node) { return; }

        try {
            reduceMotion = !!(window.matchMedia &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        } catch (e) {
            reduceMotion = false;
        }

        bag = shuffled();
        node.textContent = bag.pop();
        node.style.opacity = "1";

        timer = window.setInterval(tick, INTERVAL_MS);
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
