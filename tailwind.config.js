/** Tailwind CSS 配置（阿昌数字分身页）
 *
 * 只扫描 index.html 与 js/twin.js，产出 css/twin.css。
 * 构建方式见 tools/build-css.ps1。
 */
module.exports = {
  content: ["./index.html", "./js/twin.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto",
          '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"',
          '"Noto Sans SC"', "sans-serif"
        ]
      }
    }
  },
  plugins: []
};
