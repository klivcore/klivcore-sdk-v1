// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

// ../../node_modules/.bun/hjson@3.2.2/node_modules/hjson/bundle/hjson.js
var require_hjson = __commonJS((exports, module) => {
  /*!
   * Hjson v3.2.1
   * https://hjson.github.io
   *
   * Copyright 2014-2017 Christian Zangl, MIT license
   * Details and documentation:
   * https://github.com/hjson/hjson-js
   *
   * This code is based on the the JSON version by Douglas Crockford:
   * https://github.com/douglascrockford/JSON-js (json_parse.js, json2.js)
   */
  (function(f) {
    if (typeof exports === "object" && typeof module !== "undefined") {
      module.exports = f();
    } else if (typeof define === "function" && define.amd) {
      define([], f);
    } else {
      var g;
      if (typeof window !== "undefined") {
        g = window;
      } else if (typeof global !== "undefined") {
        g = global;
      } else if (typeof self !== "undefined") {
        g = self;
      } else {
        g = this;
      }
      g.Hjson = f();
    }
  })(function() {
    var define2, module2, exports2;
    return function() {
      function r(e, n, t) {
        function o(i2, f) {
          if (!n[i2]) {
            if (!e[i2]) {
              var c = __require;
              if (!f && c)
                return c(i2, true);
              if (u)
                return u(i2, true);
              var a = new Error("Cannot find module '" + i2 + "'");
              throw a.code = "MODULE_NOT_FOUND", a;
            }
            var p = n[i2] = { exports: {} };
            e[i2][0].call(p.exports, function(r2) {
              var n2 = e[i2][1][r2];
              return o(n2 || r2);
            }, p, p.exports, r, e, n, t);
          }
          return n[i2].exports;
        }
        for (var u = __require, i = 0;i < t.length; i++)
          o(t[i]);
        return o;
      }
      return r;
    }()({ 1: [function(require2, module3, exports3) {
      var common = require2("./hjson-common");
      function makeComment(b, a, x) {
        var c;
        if (b)
          c = { b };
        if (a)
          (c = c || {}).a = a;
        if (x)
          (c = c || {}).x = x;
        return c;
      }
      function extractComments(value, root) {
        if (value === null || typeof value !== "object")
          return;
        var comments = common.getComment(value);
        if (comments)
          common.removeComment(value);
        var i, length;
        var any, res;
        if (Object.prototype.toString.apply(value) === "[object Array]") {
          res = { a: {} };
          for (i = 0, length = value.length;i < length; i++) {
            if (saveComment(res.a, i, comments.a[i], extractComments(value[i])))
              any = true;
          }
          if (!any && comments.e) {
            res.e = makeComment(comments.e[0], comments.e[1]);
            any = true;
          }
        } else {
          res = { s: {} };
          var keys, currentKeys = Object.keys(value);
          if (comments && comments.o) {
            keys = [];
            comments.o.concat(currentKeys).forEach(function(key2) {
              if (Object.prototype.hasOwnProperty.call(value, key2) && keys.indexOf(key2) < 0)
                keys.push(key2);
            });
          } else
            keys = currentKeys;
          res.o = keys;
          for (i = 0, length = keys.length;i < length; i++) {
            var key = keys[i];
            if (saveComment(res.s, key, comments.c[key], extractComments(value[key])))
              any = true;
          }
          if (!any && comments.e) {
            res.e = makeComment(comments.e[0], comments.e[1]);
            any = true;
          }
        }
        if (root && comments && comments.r) {
          res.r = makeComment(comments.r[0], comments.r[1]);
        }
        return any ? res : undefined;
      }
      function mergeStr() {
        var res = "";
        [].forEach.call(arguments, function(c) {
          if (c && c.trim() !== "") {
            if (res)
              res += "; ";
            res += c.trim();
          }
        });
        return res;
      }
      function mergeComments(comments, value) {
        var dropped = [];
        merge(comments, value, dropped, []);
        if (dropped.length > 0) {
          var text = rootComment(value, null, 1);
          text += `
# Orphaned comments:
`;
          dropped.forEach(function(c) {
            text += ("# " + c.path.join("/") + ": " + mergeStr(c.b, c.a, c.e)).replace(`
`, "\\n ") + `
`;
          });
          rootComment(value, text, 1);
        }
      }
      function saveComment(res, key, item, col) {
        var c = makeComment(item ? item[0] : undefined, item ? item[1] : undefined, col);
        if (c)
          res[key] = c;
        return c;
      }
      function droppedComment(path, c) {
        var res = makeComment(c.b, c.a);
        res.path = path;
        return res;
      }
      function dropAll(comments, dropped, path) {
        if (!comments)
          return;
        var i, length;
        if (comments.a) {
          for (i = 0, length = comments.a.length;i < length; i++) {
            var kpath = path.slice().concat([i]);
            var c = comments.a[i];
            if (c) {
              dropped.push(droppedComment(kpath, c));
              dropAll(c.x, dropped, kpath);
            }
          }
        } else if (comments.o) {
          comments.o.forEach(function(key) {
            var kpath2 = path.slice().concat([key]);
            var c2 = comments.s[key];
            if (c2) {
              dropped.push(droppedComment(kpath2, c2));
              dropAll(c2.x, dropped, kpath2);
            }
          });
        }
        if (comments.e)
          dropped.push(droppedComment(path, comments.e));
      }
      function merge(comments, value, dropped, path) {
        if (!comments)
          return;
        if (value === null || typeof value !== "object") {
          dropAll(comments, dropped, path);
          return;
        }
        var i;
        var setComments = common.createComment(value);
        if (path.length === 0 && comments.r)
          setComments.r = [comments.r.b, comments.r.a];
        if (Object.prototype.toString.apply(value) === "[object Array]") {
          setComments.a = [];
          var a = comments.a || {};
          for (var key in a) {
            if (a.hasOwnProperty(key)) {
              i = parseInt(key);
              var c = comments.a[key];
              if (c) {
                var kpath = path.slice().concat([i]);
                if (i < value.length) {
                  setComments.a[i] = [c.b, c.a];
                  merge(c.x, value[i], dropped, kpath);
                } else {
                  dropped.push(droppedComment(kpath, c));
                  dropAll(c.x, dropped, kpath);
                }
              }
            }
          }
          if (i === 0 && comments.e)
            setComments.e = [comments.e.b, comments.e.a];
        } else {
          setComments.c = {};
          setComments.o = [];
          (comments.o || []).forEach(function(key2) {
            var kpath2 = path.slice().concat([key2]);
            var c2 = comments.s[key2];
            if (Object.prototype.hasOwnProperty.call(value, key2)) {
              setComments.o.push(key2);
              if (c2) {
                setComments.c[key2] = [c2.b, c2.a];
                merge(c2.x, value[key2], dropped, kpath2);
              }
            } else if (c2) {
              dropped.push(droppedComment(kpath2, c2));
              dropAll(c2.x, dropped, kpath2);
            }
          });
          if (comments.e)
            setComments.e = [comments.e.b, comments.e.a];
        }
      }
      function rootComment(value, setText, header) {
        var comment = common.createComment(value, common.getComment(value));
        if (!comment.r)
          comment.r = ["", ""];
        if (setText || setText === "")
          comment.r[header] = common.forceComment(setText);
        return comment.r[header] || "";
      }
      module3.exports = {
        extract: function(value) {
          return extractComments(value, true);
        },
        merge: mergeComments,
        header: function(value, setText) {
          return rootComment(value, setText, 0);
        },
        footer: function(value, setText) {
          return rootComment(value, setText, 1);
        }
      };
    }, { "./hjson-common": 2 }], 2: [function(require2, module3, exports3) {
      var os = require2("os");
      function tryParseNumber(text, stopAtNext) {
        var number, string = "", leadingZeros = 0, testLeading = true;
        var at = 0;
        var ch;
        function next() {
          ch = text.charAt(at);
          at++;
          return ch;
        }
        next();
        if (ch === "-") {
          string = "-";
          next();
        }
        while (ch >= "0" && ch <= "9") {
          if (testLeading) {
            if (ch == "0")
              leadingZeros++;
            else
              testLeading = false;
          }
          string += ch;
          next();
        }
        if (testLeading)
          leadingZeros--;
        if (ch === ".") {
          string += ".";
          while (next() && ch >= "0" && ch <= "9")
            string += ch;
        }
        if (ch === "e" || ch === "E") {
          string += ch;
          next();
          if (ch === "-" || ch === "+") {
            string += ch;
            next();
          }
          while (ch >= "0" && ch <= "9") {
            string += ch;
            next();
          }
        }
        while (ch && ch <= " ")
          next();
        if (stopAtNext) {
          if (ch === "," || ch === "}" || ch === "]" || ch === "#" || ch === "/" && (text[at] === "/" || text[at] === "*"))
            ch = 0;
        }
        number = +string;
        if (ch || leadingZeros || !isFinite(number))
          return;
        else
          return number;
      }
      function createComment(value, comment) {
        if (Object.defineProperty)
          Object.defineProperty(value, "__COMMENTS__", { enumerable: false, writable: true });
        return value.__COMMENTS__ = comment || {};
      }
      function removeComment(value) {
        Object.defineProperty(value, "__COMMENTS__", { value: undefined });
      }
      function getComment(value) {
        return value.__COMMENTS__;
      }
      function forceComment(text) {
        if (!text)
          return "";
        var a = text.split(`
`);
        var str, i, j, len;
        for (j = 0;j < a.length; j++) {
          str = a[j];
          len = str.length;
          for (i = 0;i < len; i++) {
            var c = str[i];
            if (c === "#")
              break;
            else if (c === "/" && (str[i + 1] === "/" || str[i + 1] === "*")) {
              if (str[i + 1] === "*")
                j = a.length;
              break;
            } else if (c > " ") {
              a[j] = "# " + str;
              break;
            }
          }
        }
        return a.join(`
`);
      }
      module3.exports = {
        EOL: os.EOL || `
`,
        tryParseNumber,
        createComment,
        removeComment,
        getComment,
        forceComment
      };
    }, { os: 8 }], 3: [function(require2, module3, exports3) {
      function loadDsf(col, type) {
        if (Object.prototype.toString.apply(col) !== "[object Array]") {
          if (col)
            throw new Error("dsf option must contain an array!");
          else
            return nopDsf;
        } else if (col.length === 0)
          return nopDsf;
        var dsf = [];
        function isFunction(f) {
          return {}.toString.call(f) === "[object Function]";
        }
        col.forEach(function(x) {
          if (!x.name || !isFunction(x.parse) || !isFunction(x.stringify))
            throw new Error("extension does not match the DSF interface");
          dsf.push(function() {
            try {
              if (type == "parse") {
                return x.parse.apply(null, arguments);
              } else if (type == "stringify") {
                var res = x.stringify.apply(null, arguments);
                if (res !== undefined && (typeof res !== "string" || res.length === 0 || res[0] === '"' || [].some.call(res, function(c) {
                  return isInvalidDsfChar(c);
                })))
                  throw new Error("value may not be empty, start with a quote or contain a punctuator character except colon: " + res);
                return res;
              } else
                throw new Error("Invalid type");
            } catch (e) {
              throw new Error("DSF-" + x.name + " failed; " + e.message);
            }
          });
        });
        return runDsf.bind(null, dsf);
      }
      function runDsf(dsf, value) {
        if (dsf) {
          for (var i = 0;i < dsf.length; i++) {
            var res = dsf[i](value);
            if (res !== undefined)
              return res;
          }
        }
      }
      function nopDsf() {}
      function isInvalidDsfChar(c) {
        return c === "{" || c === "}" || c === "[" || c === "]" || c === ",";
      }
      function math() {
        return {
          name: "math",
          parse: function(value) {
            switch (value) {
              case "+inf":
              case "inf":
              case "+Inf":
              case "Inf":
                return Infinity;
              case "-inf":
              case "-Inf":
                return -Infinity;
              case "nan":
              case "NaN":
                return NaN;
            }
          },
          stringify: function(value) {
            if (typeof value !== "number")
              return;
            if (1 / value === -Infinity)
              return "-0";
            if (value === Infinity)
              return "Inf";
            if (value === -Infinity)
              return "-Inf";
            if (isNaN(value))
              return "NaN";
          }
        };
      }
      math.description = "support for Inf/inf, -Inf/-inf, Nan/naN and -0";
      function hex(opt) {
        var out = opt && opt.out;
        return {
          name: "hex",
          parse: function(value) {
            if (/^0x[0-9A-Fa-f]+$/.test(value))
              return parseInt(value, 16);
          },
          stringify: function(value) {
            if (out && Number.isInteger(value))
              return "0x" + value.toString(16);
          }
        };
      }
      hex.description = "parse hexadecimal numbers prefixed with 0x";
      function date() {
        return {
          name: "date",
          parse: function(value) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T\d{2}\:\d{2}\:\d{2}(?:.\d+)(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
              var dt = Date.parse(value);
              if (!isNaN(dt))
                return new Date(dt);
            }
          },
          stringify: function(value) {
            if (Object.prototype.toString.call(value) === "[object Date]") {
              var dt = value.toISOString();
              if (dt.indexOf("T00:00:00.000Z", dt.length - 14) !== -1)
                return dt.substr(0, 10);
              else
                return dt;
            }
          }
        };
      }
      date.description = "support ISO dates";
      module3.exports = {
        loadDsf,
        std: {
          math,
          hex,
          date
        }
      };
    }, {}], 4: [function(require2, module3, exports3) {
      module3.exports = function(source, opt) {
        var common = require2("./hjson-common");
        var dsf = require2("./hjson-dsf");
        var text;
        var at;
        var ch;
        var escapee = {
          '"': '"',
          "'": "'",
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: `
`,
          r: "\r",
          t: "\t"
        };
        var keepComments;
        var runDsf;
        function resetAt() {
          at = 0;
          ch = " ";
        }
        function isPunctuatorChar(c) {
          return c === "{" || c === "}" || c === "[" || c === "]" || c === "," || c === ":";
        }
        function error(m) {
          var i, col = 0, line = 1;
          for (i = at - 1;i > 0 && text[i] !== `
`; i--, col++) {}
          for (;i > 0; i--)
            if (text[i] === `
`)
              line++;
          throw new Error(m + " at line " + line + "," + col + " >>>" + text.substr(at - col, 20) + " ...");
        }
        function next() {
          ch = text.charAt(at);
          at++;
          return ch;
        }
        function peek(offs) {
          return text.charAt(at + offs);
        }
        function string(allowML) {
          var string2 = "";
          var exitCh = ch;
          while (next()) {
            if (ch === exitCh) {
              next();
              if (allowML && exitCh === "'" && ch === "'" && string2.length === 0) {
                next();
                return mlString();
              } else
                return string2;
            }
            if (ch === "\\") {
              next();
              if (ch === "u") {
                var uffff = 0;
                for (var i = 0;i < 4; i++) {
                  next();
                  var c = ch.charCodeAt(0), hex;
                  if (ch >= "0" && ch <= "9")
                    hex = c - 48;
                  else if (ch >= "a" && ch <= "f")
                    hex = c - 97 + 10;
                  else if (ch >= "A" && ch <= "F")
                    hex = c - 65 + 10;
                  else
                    error("Bad \\u char " + ch);
                  uffff = uffff * 16 + hex;
                }
                string2 += String.fromCharCode(uffff);
              } else if (typeof escapee[ch] === "string") {
                string2 += escapee[ch];
              } else
                break;
            } else if (ch === `
` || ch === "\r") {
              error("Bad string containing newline");
            } else {
              string2 += ch;
            }
          }
          error("Bad string");
        }
        function mlString() {
          var string2 = "", triple = 0;
          var indent = 0;
          for (;; ) {
            var c = peek(-indent - 5);
            if (!c || c === `
`)
              break;
            indent++;
          }
          function skipIndent() {
            var skip = indent;
            while (ch && ch <= " " && ch !== `
` && skip-- > 0)
              next();
          }
          while (ch && ch <= " " && ch !== `
`)
            next();
          if (ch === `
`) {
            next();
            skipIndent();
          }
          for (;; ) {
            if (!ch) {
              error("Bad multiline string");
            } else if (ch === "'") {
              triple++;
              next();
              if (triple === 3) {
                if (string2.slice(-1) === `
`)
                  string2 = string2.slice(0, -1);
                return string2;
              } else
                continue;
            } else {
              while (triple > 0) {
                string2 += "'";
                triple--;
              }
            }
            if (ch === `
`) {
              string2 += `
`;
              next();
              skipIndent();
            } else {
              if (ch !== "\r")
                string2 += ch;
              next();
            }
          }
        }
        function keyname() {
          if (ch === '"' || ch === "'")
            return string(false);
          var name = "", start = at, space = -1;
          for (;; ) {
            if (ch === ":") {
              if (!name)
                error("Found ':' but no key name (for an empty key name use quotes)");
              else if (space >= 0 && space !== name.length) {
                at = start + space;
                error("Found whitespace in your key name (use quotes to include)");
              }
              return name;
            } else if (ch <= " ") {
              if (!ch)
                error("Found EOF while looking for a key name (check your syntax)");
              else if (space < 0)
                space = name.length;
            } else if (isPunctuatorChar(ch)) {
              error("Found '" + ch + "' where a key name was expected (check your syntax or use quotes if the key name includes {}[],: or whitespace)");
            } else {
              name += ch;
            }
            next();
          }
        }
        function white() {
          while (ch) {
            while (ch && ch <= " ")
              next();
            if (ch === "#" || ch === "/" && peek(0) === "/") {
              while (ch && ch !== `
`)
                next();
            } else if (ch === "/" && peek(0) === "*") {
              next();
              next();
              while (ch && !(ch === "*" && peek(0) === "/"))
                next();
              if (ch) {
                next();
                next();
              }
            } else
              break;
          }
        }
        function tfnns() {
          var value2 = ch;
          if (isPunctuatorChar(ch))
            error("Found a punctuator character '" + ch + "' when expecting a quoteless string (check your syntax)");
          for (;; ) {
            next();
            var isEol = ch === "\r" || ch === `
` || ch === "";
            if (isEol || ch === "," || ch === "}" || ch === "]" || ch === "#" || ch === "/" && (peek(0) === "/" || peek(0) === "*")) {
              var chf = value2[0];
              switch (chf) {
                case "f":
                  if (value2.trim() === "false")
                    return false;
                  break;
                case "n":
                  if (value2.trim() === "null")
                    return null;
                  break;
                case "t":
                  if (value2.trim() === "true")
                    return true;
                  break;
                default:
                  if (chf === "-" || chf >= "0" && chf <= "9") {
                    var n = common.tryParseNumber(value2);
                    if (n !== undefined)
                      return n;
                  }
              }
              if (isEol) {
                value2 = value2.trim();
                var dsfValue = runDsf(value2);
                return dsfValue !== undefined ? dsfValue : value2;
              }
            }
            value2 += ch;
          }
        }
        function getComment(cAt, first) {
          var i;
          cAt--;
          for (i = at - 2;i > cAt && text[i] <= " " && text[i] !== `
`; i--)
            ;
          if (text[i] === `
`)
            i--;
          if (text[i] === "\r")
            i--;
          var res = text.substr(cAt, i - cAt + 1);
          for (i = 0;i < res.length; i++) {
            if (res[i] > " ") {
              var j = res.indexOf(`
`);
              if (j >= 0) {
                var c = [res.substr(0, j), res.substr(j + 1)];
                if (first && c[0].trim().length === 0)
                  c.shift();
                return c;
              } else
                return [res];
            }
          }
          return [];
        }
        function errorClosingHint(value2) {
          function search(value3, ch2) {
            var i, k, length, res;
            switch (typeof value3) {
              case "string":
                if (value3.indexOf(ch2) >= 0)
                  res = value3;
                break;
              case "object":
                if (Object.prototype.toString.apply(value3) === "[object Array]") {
                  for (i = 0, length = value3.length;i < length; i++) {
                    res = search(value3[i], ch2) || res;
                  }
                } else {
                  for (k in value3) {
                    if (!Object.prototype.hasOwnProperty.call(value3, k))
                      continue;
                    res = search(value3[k], ch2) || res;
                  }
                }
            }
            return res;
          }
          function report(ch2) {
            var possibleErr = search(value2, ch2);
            if (possibleErr) {
              return "found '" + ch2 + `' in a string value, your mistake could be with:
` + "  > " + possibleErr + `
` + "  (unquoted strings contain everything up to the next line!)";
            } else
              return "";
          }
          return report("}") || report("]");
        }
        function array() {
          var array2 = [];
          var comments, cAt, nextComment;
          try {
            if (keepComments)
              comments = common.createComment(array2, { a: [] });
            next();
            cAt = at;
            white();
            if (comments)
              nextComment = getComment(cAt, true).join(`
`);
            if (ch === "]") {
              next();
              if (comments)
                comments.e = [nextComment];
              return array2;
            }
            while (ch) {
              array2.push(value());
              cAt = at;
              white();
              if (ch === ",") {
                next();
                cAt = at;
                white();
              }
              if (comments) {
                var c = getComment(cAt);
                comments.a.push([nextComment || "", c[0] || ""]);
                nextComment = c[1];
              }
              if (ch === "]") {
                next();
                if (comments)
                  comments.a[comments.a.length - 1][1] += nextComment || "";
                return array2;
              }
              white();
            }
            error("End of input while parsing an array (missing ']')");
          } catch (e) {
            e.hint = e.hint || errorClosingHint(array2);
            throw e;
          }
        }
        function object(withoutBraces) {
          var key = "", object2 = {};
          var comments, cAt, nextComment;
          try {
            if (keepComments)
              comments = common.createComment(object2, { c: {}, o: [] });
            if (!withoutBraces) {
              next();
              cAt = at;
            } else
              cAt = 1;
            white();
            if (comments)
              nextComment = getComment(cAt, true).join(`
`);
            if (ch === "}" && !withoutBraces) {
              if (comments)
                comments.e = [nextComment];
              next();
              return object2;
            }
            while (ch) {
              key = keyname();
              white();
              if (ch !== ":")
                error("Expected ':' instead of '" + ch + "'");
              next();
              object2[key] = value();
              cAt = at;
              white();
              if (ch === ",") {
                next();
                cAt = at;
                white();
              }
              if (comments) {
                var c = getComment(cAt);
                comments.c[key] = [nextComment || "", c[0] || ""];
                nextComment = c[1];
                comments.o.push(key);
              }
              if (ch === "}" && !withoutBraces) {
                next();
                if (comments)
                  comments.c[key][1] += nextComment || "";
                return object2;
              }
              white();
            }
            if (withoutBraces)
              return object2;
            else
              error("End of input while parsing an object (missing '}')");
          } catch (e) {
            e.hint = e.hint || errorClosingHint(object2);
            throw e;
          }
        }
        function value() {
          white();
          switch (ch) {
            case "{":
              return object();
            case "[":
              return array();
            case "'":
            case '"':
              return string(true);
            default:
              return tfnns();
          }
        }
        function checkTrailing(v, c) {
          var cAt = at;
          white();
          if (ch)
            error("Syntax error, found trailing characters");
          if (keepComments) {
            var b = c.join(`
`), a = getComment(cAt).join(`
`);
            if (a || b) {
              var comments = common.createComment(v, common.getComment(v));
              comments.r = [b, a];
            }
          }
          return v;
        }
        function rootValue() {
          white();
          var c = keepComments ? getComment(1) : null;
          switch (ch) {
            case "{":
              return checkTrailing(object(), c);
            case "[":
              return checkTrailing(array(), c);
            default:
              return checkTrailing(value(), c);
          }
        }
        function legacyRootValue() {
          white();
          var c = keepComments ? getComment(1) : null;
          switch (ch) {
            case "{":
              return checkTrailing(object(), c);
            case "[":
              return checkTrailing(array(), c);
          }
          try {
            return checkTrailing(object(true), c);
          } catch (e) {
            resetAt();
            try {
              return checkTrailing(value(), c);
            } catch (e2) {
              throw e;
            }
          }
        }
        if (typeof source !== "string")
          throw new Error("source is not a string");
        var dsfDef = null;
        var legacyRoot = true;
        if (opt && typeof opt === "object") {
          keepComments = opt.keepWsc;
          dsfDef = opt.dsf;
          legacyRoot = opt.legacyRoot !== false;
        }
        runDsf = dsf.loadDsf(dsfDef, "parse");
        text = source;
        resetAt();
        return legacyRoot ? legacyRootValue() : rootValue();
      };
    }, { "./hjson-common": 2, "./hjson-dsf": 3 }], 5: [function(require2, module3, exports3) {
      module3.exports = function(data, opt) {
        var common = require2("./hjson-common");
        var dsf = require2("./hjson-dsf");
        var plainToken = {
          obj: ["{", "}"],
          arr: ["[", "]"],
          key: ["", ""],
          qkey: ['"', '"'],
          col: [":", ""],
          com: [",", ""],
          str: ["", ""],
          qstr: ['"', '"'],
          mstr: ["'''", "'''"],
          num: ["", ""],
          lit: ["", ""],
          dsf: ["", ""],
          esc: ["\\", ""],
          uni: ["\\u", ""],
          rem: ["", ""]
        };
        var eol = common.EOL;
        var indent = "  ";
        var keepComments = false;
        var bracesSameLine = false;
        var quoteKeys = false;
        var quoteStrings = false;
        var condense = 0;
        var multiline = 1;
        var separator = "";
        var dsfDef = null;
        var sortProps = false;
        var token = plainToken;
        if (opt && typeof opt === "object") {
          opt.quotes = opt.quotes === "always" ? "strings" : opt.quotes;
          if (opt.eol === `
` || opt.eol === `\r
`)
            eol = opt.eol;
          keepComments = opt.keepWsc;
          condense = opt.condense || 0;
          bracesSameLine = opt.bracesSameLine;
          quoteKeys = opt.quotes === "all" || opt.quotes === "keys";
          quoteStrings = opt.quotes === "all" || opt.quotes === "strings" || opt.separator === true;
          if (quoteStrings || opt.multiline == "off")
            multiline = 0;
          else
            multiline = opt.multiline == "no-tabs" ? 2 : 1;
          separator = opt.separator === true ? token.com[0] : "";
          dsfDef = opt.dsf;
          sortProps = opt.sortProps;
          if (typeof opt.space === "number") {
            indent = new Array(opt.space + 1).join(" ");
          } else if (typeof opt.space === "string") {
            indent = opt.space;
          }
          if (opt.colors === true) {
            token = {
              obj: ["\x1B[37m{\x1B[0m", "\x1B[37m}\x1B[0m"],
              arr: ["\x1B[37m[\x1B[0m", "\x1B[37m]\x1B[0m"],
              key: ["\x1B[33m", "\x1B[0m"],
              qkey: ['\x1B[33m"', '"\x1B[0m'],
              col: ["\x1B[37m:\x1B[0m", ""],
              com: ["\x1B[37m,\x1B[0m", ""],
              str: ["\x1B[37;1m", "\x1B[0m"],
              qstr: ['\x1B[37;1m"', '"\x1B[0m'],
              mstr: ["\x1B[37;1m'''", "'''\x1B[0m"],
              num: ["\x1B[36;1m", "\x1B[0m"],
              lit: ["\x1B[36m", "\x1B[0m"],
              dsf: ["\x1B[37m", "\x1B[0m"],
              esc: ["\x1B[31m\\", "\x1B[0m"],
              uni: ["\x1B[31m\\u", "\x1B[0m"],
              rem: ["\x1B[35m", "\x1B[0m"]
            };
          }
          var i, ckeys = Object.keys(plainToken);
          for (i = ckeys.length - 1;i >= 0; i--) {
            var k = ckeys[i];
            token[k].push(plainToken[k][0].length, plainToken[k][1].length);
          }
        }
        var runDsf;
        var commonRange = "\x7F-\x9F\xAD\u0600-\u0604\u070F\u17B4\u17B5\u200C-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF0-\uFFFF";
        var needsEscape = new RegExp("[\\\\\\\"\x00-\x1F" + commonRange + "]", "g");
        var needsQuotes = new RegExp(`^\\s|^"|^'|^#|^\\/\\*|^\\/\\/|^\\{|^\\}|^\\[|^\\]|^:|^,|\\s$|[\x00-\x1F` + commonRange + "]", "g");
        var needsEscapeML = new RegExp("'''|^[\\s]+$|[\x00-" + (multiline === 2 ? "\t" : "\b") + "\v\f\x0E-\x1F" + commonRange + "]", "g");
        var startsWithKeyword = new RegExp("^(true|false|null)\\s*((,|\\]|\\}|#|//|/\\*).*)?$");
        var meta = {
          "\b": "b",
          "\t": "t",
          "\n": "n",
          "\f": "f",
          "\r": "r",
          '"': '"',
          "\\": "\\"
        };
        var needsEscapeName = /[,\{\[\}\]\s:#"']|\/\/|\/\*/;
        var gap = "";
        var wrapLen = 0;
        function wrap(tk, v) {
          wrapLen += tk[0].length + tk[1].length - tk[2] - tk[3];
          return tk[0] + v + tk[1];
        }
        function quoteReplace(string) {
          return string.replace(needsEscape, function(a) {
            var c = meta[a];
            if (typeof c === "string")
              return wrap(token.esc, c);
            else
              return wrap(token.uni, ("0000" + a.charCodeAt(0).toString(16)).slice(-4));
          });
        }
        function quote(string, gap2, hasComment, isRootObject) {
          if (!string)
            return wrap(token.qstr, "");
          needsQuotes.lastIndex = 0;
          startsWithKeyword.lastIndex = 0;
          if (quoteStrings || hasComment || needsQuotes.test(string) || common.tryParseNumber(string, true) !== undefined || startsWithKeyword.test(string)) {
            needsEscape.lastIndex = 0;
            needsEscapeML.lastIndex = 0;
            if (!needsEscape.test(string))
              return wrap(token.qstr, string);
            else if (!needsEscapeML.test(string) && !isRootObject && multiline)
              return mlString(string, gap2);
            else
              return wrap(token.qstr, quoteReplace(string));
          } else {
            return wrap(token.str, string);
          }
        }
        function mlString(string, gap2) {
          var i2, a = string.replace(/\r/g, "").split(`
`);
          gap2 += indent;
          if (a.length === 1) {
            return wrap(token.mstr, a[0]);
          } else {
            var res2 = eol + gap2 + token.mstr[0];
            for (i2 = 0;i2 < a.length; i2++) {
              res2 += eol;
              if (a[i2])
                res2 += gap2 + a[i2];
            }
            return res2 + eol + gap2 + token.mstr[1];
          }
        }
        function quoteKey(name) {
          if (!name)
            return '""';
          if (quoteKeys || needsEscapeName.test(name)) {
            needsEscape.lastIndex = 0;
            return wrap(token.qkey, needsEscape.test(name) ? quoteReplace(name) : name);
          } else {
            return wrap(token.key, name);
          }
        }
        function str(value, hasComment, noIndent, isRootObject) {
          function startsWithNL(str2) {
            return str2 && str2[str2[0] === "\r" ? 1 : 0] === `
`;
          }
          function commentOnThisLine(str2) {
            return str2 && !startsWithNL(str2);
          }
          function makeComment(str2, prefix2, trim) {
            if (!str2)
              return "";
            str2 = common.forceComment(str2);
            var i3, len = str2.length;
            for (i3 = 0;i3 < len && str2[i3] <= " "; i3++) {}
            if (trim && i3 > 0)
              str2 = str2.substr(i3);
            if (i3 < len)
              return prefix2 + wrap(token.rem, str2);
            else
              return str2;
          }
          var dsfValue = runDsf(value);
          if (dsfValue !== undefined)
            return wrap(token.dsf, dsfValue);
          switch (typeof value) {
            case "string":
              return quote(value, gap, hasComment, isRootObject);
            case "number":
              return isFinite(value) ? wrap(token.num, String(value)) : wrap(token.lit, "null");
            case "boolean":
              return wrap(token.lit, String(value));
            case "object":
              if (!value)
                return wrap(token.lit, "null");
              var comments2;
              if (keepComments)
                comments2 = common.getComment(value);
              var isArray = Object.prototype.toString.apply(value) === "[object Array]";
              var mind = gap;
              gap += indent;
              var eolMind = eol + mind;
              var eolGap = eol + gap;
              var prefix = noIndent || bracesSameLine ? "" : eolMind;
              var partial = [];
              var setsep;
              var cpartial = condense ? [] : null;
              var saveQuoteStrings = quoteStrings, saveMultiline = multiline;
              var iseparator = separator ? "" : token.com[0];
              var cwrapLen = 0;
              var i2, length;
              var k2, v, vs;
              var c, ca;
              var res2, cres;
              if (isArray) {
                for (i2 = 0, length = value.length;i2 < length; i2++) {
                  setsep = i2 < length - 1;
                  if (comments2) {
                    c = comments2.a[i2] || [];
                    ca = commentOnThisLine(c[1]);
                    partial.push(makeComment(c[0], `
`) + eolGap);
                    if (cpartial && (c[0] || c[1] || ca))
                      cpartial = null;
                  } else
                    partial.push(eolGap);
                  wrapLen = 0;
                  v = value[i2];
                  partial.push(str(v, comments2 ? ca : false, true) + (setsep ? separator : ""));
                  if (cpartial) {
                    switch (typeof v) {
                      case "string":
                        wrapLen = 0;
                        quoteStrings = true;
                        multiline = 0;
                        cpartial.push(str(v, false, true) + (setsep ? token.com[0] : ""));
                        quoteStrings = saveQuoteStrings;
                        multiline = saveMultiline;
                        break;
                      case "object":
                        if (v) {
                          cpartial = null;
                          break;
                        }
                      default:
                        cpartial.push(partial[partial.length - 1] + (setsep ? iseparator : ""));
                        break;
                    }
                    if (setsep)
                      wrapLen += token.com[0].length - token.com[2];
                    cwrapLen += wrapLen;
                  }
                  if (comments2 && c[1])
                    partial.push(makeComment(c[1], ca ? " " : `
`, ca));
                }
                if (length === 0) {
                  if (comments2 && comments2.e)
                    partial.push(makeComment(comments2.e[0], `
`) + eolMind);
                } else
                  partial.push(eolMind);
                if (partial.length === 0)
                  res2 = wrap(token.arr, "");
                else {
                  res2 = prefix + wrap(token.arr, partial.join(""));
                  if (cpartial) {
                    cres = cpartial.join(" ");
                    if (cres.length - cwrapLen <= condense)
                      res2 = wrap(token.arr, cres);
                  }
                }
              } else {
                var commentKeys = comments2 ? comments2.o.slice() : [];
                var objectKeys = [];
                for (k2 in value) {
                  if (Object.prototype.hasOwnProperty.call(value, k2) && commentKeys.indexOf(k2) < 0)
                    objectKeys.push(k2);
                }
                if (sortProps) {
                  objectKeys.sort();
                }
                var keys = commentKeys.concat(objectKeys);
                for (i2 = 0, length = keys.length;i2 < length; i2++) {
                  setsep = i2 < length - 1;
                  k2 = keys[i2];
                  if (comments2) {
                    c = comments2.c[k2] || [];
                    ca = commentOnThisLine(c[1]);
                    partial.push(makeComment(c[0], `
`) + eolGap);
                    if (cpartial && (c[0] || c[1] || ca))
                      cpartial = null;
                  } else
                    partial.push(eolGap);
                  wrapLen = 0;
                  v = value[k2];
                  vs = str(v, comments2 && ca);
                  partial.push(quoteKey(k2) + token.col[0] + (startsWithNL(vs) ? "" : " ") + vs + (setsep ? separator : ""));
                  if (comments2 && c[1])
                    partial.push(makeComment(c[1], ca ? " " : `
`, ca));
                  if (cpartial) {
                    switch (typeof v) {
                      case "string":
                        wrapLen = 0;
                        quoteStrings = true;
                        multiline = 0;
                        vs = str(v, false);
                        quoteStrings = saveQuoteStrings;
                        multiline = saveMultiline;
                        cpartial.push(quoteKey(k2) + token.col[0] + " " + vs + (setsep ? token.com[0] : ""));
                        break;
                      case "object":
                        if (v) {
                          cpartial = null;
                          break;
                        }
                      default:
                        cpartial.push(partial[partial.length - 1] + (setsep ? iseparator : ""));
                        break;
                    }
                    wrapLen += token.col[0].length - token.col[2];
                    if (setsep)
                      wrapLen += token.com[0].length - token.com[2];
                    cwrapLen += wrapLen;
                  }
                }
                if (length === 0) {
                  if (comments2 && comments2.e)
                    partial.push(makeComment(comments2.e[0], `
`) + eolMind);
                } else
                  partial.push(eolMind);
                if (partial.length === 0) {
                  res2 = wrap(token.obj, "");
                } else {
                  res2 = prefix + wrap(token.obj, partial.join(""));
                  if (cpartial) {
                    cres = cpartial.join(" ");
                    if (cres.length - cwrapLen <= condense)
                      res2 = wrap(token.obj, cres);
                  }
                }
              }
              gap = mind;
              return res2;
          }
        }
        runDsf = dsf.loadDsf(dsfDef, "stringify");
        var res = "";
        var comments = keepComments ? comments = (common.getComment(data) || {}).r : null;
        if (comments && comments[0])
          res = comments[0] + `
`;
        res += str(data, null, true, true);
        if (comments)
          res += comments[1] || "";
        return res;
      };
    }, { "./hjson-common": 2, "./hjson-dsf": 3 }], 6: [function(require2, module3, exports3) {
      module3.exports = "3.2.1";
    }, {}], 7: [function(require2, module3, exports3) {
      /*!
       * Hjson v3.2.1
       * https://hjson.github.io
       *
       * Copyright 2014-2017 Christian Zangl, MIT license
       * Details and documentation:
       * https://github.com/hjson/hjson-js
       *
       * This code is based on the the JSON version by Douglas Crockford:
       * https://github.com/douglascrockford/JSON-js (json_parse.js, json2.js)
       */
      var common = require2("./hjson-common");
      var version = require2("./hjson-version");
      var parse = require2("./hjson-parse");
      var stringify = require2("./hjson-stringify");
      var comments = require2("./hjson-comments");
      var dsf = require2("./hjson-dsf");
      module3.exports = {
        parse,
        stringify,
        endOfLine: function() {
          return common.EOL;
        },
        setEndOfLine: function(eol) {
          if (eol === `
` || eol === `\r
`)
            common.EOL = eol;
        },
        version,
        rt: {
          parse: function(text, options) {
            (options = options || {}).keepWsc = true;
            return parse(text, options);
          },
          stringify: function(value, options) {
            (options = options || {}).keepWsc = true;
            return stringify(value, options);
          }
        },
        comments,
        dsf: dsf.std
      };
    }, { "./hjson-comments": 1, "./hjson-common": 2, "./hjson-dsf": 3, "./hjson-parse": 4, "./hjson-stringify": 5, "./hjson-version": 6 }], 8: [function(require2, module3, exports3) {}, {}] }, {}, [7])(7);
  });
});

// packages/publish-sdk/src/gateway-server.ts
import { readFile as readFile2 } from "fs/promises";
import { resolve as resolve3 } from "path";

// packages/publish-sdk/src/gateway-server-core.ts
import { constants } from "fs";
import { chmod, lstat as lstat2, mkdir as mkdir3, open as open2, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname3, isAbsolute, resolve as resolve2 } from "path";

// packages/server/src/index.ts
import { lstat, mkdir as mkdir2, open, readFile, readdir, rename, rm as rm2, stat, unlink, utimes, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { homedir } from "os";
import { basename as basename2, dirname as dirname2, extname, join as join2, relative, resolve, sep } from "path";
import { promisify } from "util";
// packages/core/src/benchMerge.ts
var missing = Symbol("missing");
function mergeBenchDocuments(base, desired, current) {
  const conflicts = [];
  const merged = mergeObject(base, desired, current, "", conflicts);
  return {
    conflicts,
    document: conflicts.length ? current : merged
  };
}
function mergeObject(base, desired, current, path, conflicts) {
  const result = cloneValue(current);
  const keys = new Set([...Object.keys(base), ...Object.keys(desired), ...Object.keys(current)]);
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    const baseValue = ownValue(base, key);
    const desiredValue = ownValue(desired, key);
    const currentValue = ownValue(current, key);
    const merged = key === "elements" || key === "edges" ? mergeRecordCollection(baseValue, desiredValue, currentValue, childPath, conflicts) : mergeValue(baseValue, desiredValue, currentValue, childPath, conflicts);
    if (merged === missing)
      delete result[key];
    else
      result[key] = merged;
  }
  return result;
}
function mergeValue(base, desired, current, path, conflicts) {
  if (equalValue(desired, base))
    return cloneValue(current);
  if (equalValue(current, desired))
    return cloneValue(current);
  if (equalValue(current, base))
    return cloneWithCurrentHjsonTrivia(desired, current);
  if (isRecord(base) && isRecord(desired) && isRecord(current))
    return mergeObject(base, desired, current, path, conflicts);
  conflicts.push({
    base: publicValue(base),
    current: publicValue(current),
    desired: publicValue(desired),
    path
  });
  return cloneValue(current);
}
function mergeRecordCollection(base, desired, current, path, conflicts) {
  if (equalValue(desired, base))
    return cloneValue(current);
  if (!Array.isArray(base) || !Array.isArray(desired) || !Array.isArray(current)) {
    return mergeValue(base, desired, current, path, conflicts);
  }
  const baseRecords = recordsById(base, path);
  const desiredRecords = recordsById(desired, path);
  const currentRecords = recordsById(current, path);
  const mergedById = new Map;
  const allIds = new Set([...baseRecords.keys(), ...desiredRecords.keys(), ...currentRecords.keys()]);
  for (const id of allIds) {
    const recordPath = `${path}.${id}`;
    const merged = mergeValue(baseRecords.get(id) ?? missing, desiredRecords.get(id) ?? missing, currentRecords.get(id) ?? missing, recordPath, conflicts);
    if (merged !== missing)
      mergedById.set(id, merged);
  }
  const result = [];
  for (const record of current) {
    const id = recordId(record, path);
    const merged = mergedById.get(id);
    if (merged) {
      result.push(merged);
      mergedById.delete(id);
    }
  }
  for (const record of desired) {
    const id = recordId(record, path);
    const merged = mergedById.get(id);
    if (merged) {
      result.push(merged);
      mergedById.delete(id);
    }
  }
  const comparableIds = new Set([...baseRecords.keys()].filter((id) => desiredRecords.has(id) && currentRecords.has(id) && result.some((record) => record.id === id)));
  const baseOrder = [...baseRecords.keys()].filter((id) => comparableIds.has(id));
  const desiredOrder = [...desiredRecords.keys()].filter((id) => comparableIds.has(id));
  const currentOrder = [...currentRecords.keys()].filter((id) => comparableIds.has(id));
  const desiredReordered = !equalValue(desiredOrder, baseOrder);
  const currentReorderedDifferently = !equalValue(currentOrder, baseOrder) && !equalValue(currentOrder, desiredOrder);
  if (desiredReordered && currentReorderedDifferently) {
    conflicts.push({ base: baseOrder, current: currentOrder, desired: desiredOrder, path: `${path}.$order` });
    return result;
  }
  if (!desiredReordered)
    return result;
  const reordered = new Map(result.filter((record) => comparableIds.has(record.id)).map((record) => [record.id, record]));
  const queue = desiredOrder.map((id) => reordered.get(id));
  return result.map((record) => comparableIds.has(record.id) ? queue.shift() : record);
}
function recordsById(value, path) {
  const result = new Map;
  for (const record of value) {
    const id = recordId(record, path);
    if (result.has(id))
      throw new Error(`Duplicate bench record id at ${path}: ${id}`);
    result.set(id, record);
  }
  return result;
}
function recordId(value, path) {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    throw new Error(`Bench records at ${path} require stable non-empty ids`);
  }
  return value.id;
}
function ownValue(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : missing;
}
function publicValue(value) {
  return value === missing ? { absent: true } : cloneValue(value);
}
function cloneValue(value) {
  if (value === missing)
    return missing;
  if (Array.isArray(value))
    return copyHjsonTrivia(value, value.map((item) => cloneValue(item)));
  if (isRecord(value)) {
    const clone = {};
    for (const [key, item] of Object.entries(value))
      clone[key] = cloneValue(item);
    return copyHjsonTrivia(value, clone);
  }
  return value;
}
function copyHjsonTrivia(source, target) {
  const descriptor = Object.getOwnPropertyDescriptor(source, "__COMMENTS__");
  if (descriptor)
    Object.defineProperty(target, "__COMMENTS__", descriptor);
  return target;
}
function cloneWithCurrentHjsonTrivia(desired, current) {
  const clone = cloneValue(desired);
  if (clone === missing || current === missing || !clone || typeof clone !== "object" || !current || typeof current !== "object")
    return clone;
  copyHjsonTrivia(current, clone);
  if (Array.isArray(clone) && Array.isArray(current)) {
    for (let index = 0;index < Math.min(clone.length, current.length); index += 1)
      clone[index] = cloneWithCurrentHjsonTrivia(clone[index], current[index]);
  } else if (isRecord(clone) && isRecord(current)) {
    for (const key of Object.keys(clone)) {
      if (Object.prototype.hasOwnProperty.call(current, key))
        clone[key] = cloneWithCurrentHjsonTrivia(clone[key], current[key]);
    }
  }
  return clone;
}
function equalValue(left, right) {
  if (left === missing || right === missing)
    return left === right;
  if (Object.is(left, right))
    return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right))
      return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equalValue(left[key], right[key]));
  }
  return false;
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
// packages/core/src/benchDocumentFormat.ts
var import_hjson = __toESM(require_hjson(), 1);
function getBenchDocumentFormat(path) {
  const normalized = path.trim().toLowerCase();
  if (normalized.endsWith(".bench.hjson"))
    return "hjson";
  if (normalized.endsWith(".bench.json"))
    return "json";
  return null;
}
function isBenchDocumentPath(path) {
  return getBenchDocumentFormat(path) !== null;
}
function parseHjsonValue(content) {
  return import_hjson.default.parse(content, { keepWsc: true });
}
function parseBenchDocument(content, path) {
  const format = getBenchDocumentFormat(path);
  const parsed = format === "hjson" ? parseHjsonValue(content) : JSON.parse(content);
  if (!isRecord2(parsed))
    throw new Error(`Bench document must be an object: ${path}`);
  rejectUnsupportedBenchValues(parsed, path);
  return parsed;
}
function stringifyBenchDocument(bench, path) {
  const format = getBenchDocumentFormat(path);
  if (format === "hjson") {
    rejectUnsupportedBenchValues(bench, path);
    return `${stringifyHjsonBenchValue(bench, 0)}
`;
  }
  return `${JSON.stringify(bench, null, 2)}
`;
}
function stringifyHjsonBenchValue(value, depth) {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (value === null)
    return "null";
  if (typeof value === "string")
    return quoteHjsonString(value);
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length)
      return "[]";
    return `[
${value.map((child, index) => withHjsonComments(value, index, indentFirstLine(addTrailingComma(stringifyHjsonBenchValue(child, depth + 1)), childIndent), childIndent)).join(`
`)}
${indent}]`;
  }
  if (isRecord2(value)) {
    const entries = Object.entries(value);
    if (!entries.length)
      return "{}";
    return `{
${entries.map(([key, child]) => {
      const rendered = stringifyHjsonBenchValue(child, depth + 1);
      const lines = rendered.split(`
`);
      const firstLine = `${childIndent}${formatHjsonKey(key)}: ${lines[0]}`;
      return withHjsonComments(value, key, addTrailingComma([firstLine, ...lines.slice(1)].join(`
`)), childIndent);
    }).join(`
`)}
${indent}}`;
  }
  throw new Error(`Unsupported value in bench document: ${String(value)}`);
}
function indentFirstLine(value, indent) {
  const lines = value.split(`
`);
  return [indent + lines[0], ...lines.slice(1)].join(`
`);
}
function addTrailingComma(value) {
  const lines = value.split(`
`);
  lines[lines.length - 1] = `${lines[lines.length - 1]},`;
  return lines.join(`
`);
}
function formatHjsonKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !hjsonReservedKeys.has(key) ? key : JSON.stringify(key);
}
function quoteHjsonString(value) {
  const hasSignificantIndentation = value.split(`
`).some((line) => /^[\t ]/.test(line));
  if (value.includes(`
`) && !value.includes("'''") && !hasSignificantIndentation)
    return `'''
${value}
'''`;
  return JSON.stringify(value);
}
var hjsonReservedKeys = new Set(["true", "false", "null"]);
function withHjsonComments(container, key, rendered, indent) {
  const comments = Object.getOwnPropertyDescriptor(container, "__COMMENTS__")?.value;
  const pair = typeof key === "number" ? comments?.a?.[key] : comments?.c?.[key];
  const leading = pair?.[0]?.split(`
`).map((line) => line.trim()).filter(Boolean).map((line) => `${indent}${line}`) ?? [];
  const trailing = pair?.[1]?.trim();
  if (trailing) {
    const renderedLines = rendered.split(`
`);
    renderedLines[renderedLines.length - 1] = `${renderedLines[renderedLines.length - 1]} ${trailing}`;
    rendered = renderedLines.join(`
`);
  }
  return leading.length ? `${leading.join(`
`)}
${rendered}` : rendered;
}
function rejectUnsupportedBenchValues(value, path, seen = new WeakSet, trace = "$") {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error(`Unsupported non-finite number in bench document ${path} at ${trace}`);
  if (typeof value === "undefined")
    throw new Error(`Unsupported undefined in bench document ${path} at ${trace}`);
  if (!value || typeof value !== "object")
    return;
  if (seen.has(value))
    throw new Error(`Unsupported circular reference in bench document ${path} at ${trace}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0;index < value.length; index += 1) {
      if (!(index in value))
        throw new Error(`Unsupported sparse array in bench document ${path} at ${trace}[${index}]`);
      rejectUnsupportedBenchValues(value[index], path, seen, `${trace}[${index}]`);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`Unsupported non-plain object in bench document ${path} at ${trace}`);
  for (const [key, child] of Object.entries(value))
    rejectUnsupportedBenchValues(child, path, seen, `${trace}.${key}`);
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
// packages/core/src/fileWriteLock.ts
import { mkdir, rm } from "fs/promises";
import { basename, dirname, join } from "path";
async function withFileWriteLock(path, action, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const lockPath = join(dirname(path), `.${basename(path)}.klivcore-write-lock`);
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error))
        throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file write lock: ${lockPath}. If no writer is running, remove this stale lock directory.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
function isAlreadyExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

// packages/server/src/index.ts
function createWorkbenchServer(config) {
  const apiBasePath = normalizeApiBasePath(config.apiBasePath ?? "/api/workbench");
  const configuredRoots = [
    ...config.vaults.map((vault) => ({ ...vault, kind: "vault", readOnly: false })),
    ...config.roots ?? []
  ];
  const duplicateRootId = configuredRoots.find((root, index) => configuredRoots.findIndex((candidate) => candidate.id === root.id) !== index)?.id;
  if (duplicateRootId)
    throw new Error(`Duplicate Workbench resource root id: ${duplicateRootId}`);
  const roots = new Map(configuredRoots.map((configuredRoot) => {
    const root = resolve(configuredRoot.root);
    const cacheRoot = resolve(configuredRoot.cacheRoot ?? getDefaultRasterCacheRoot(root));
    const cacheRelativePath = relative(resolveCanonicalPath(root), resolveCanonicalPath(cacheRoot));
    if (cacheRelativePath === "" || cacheRelativePath !== ".." && !cacheRelativePath.startsWith(`..${sep}`)) {
      throw new Error(`Workbench raster cache must be outside vault root: ${configuredRoot.id}`);
    }
    return [configuredRoot.id, {
      ...configuredRoot,
      cacheMaxBytes: Math.max(1, configuredRoot.cacheMaxBytes ?? 512 * 1024 * 1024),
      cacheRoot,
      readOnly: configuredRoot.kind === "repository" ? true : configuredRoot.readOnly ?? configuredRoot.kind !== "vault",
      root
    }];
  }));
  const vaults = new Map([...roots].filter(([, root]) => root.kind === "vault"));
  const writeLocks = new Map;
  return {
    async fetch(request) {
      if (request.method === "OPTIONS")
        return emptyResponse(204);
      const url = new URL(request.url);
      if (!url.pathname.startsWith(apiBasePath))
        return jsonResponse({ error: "not-found" }, 404);
      const route = url.pathname.slice(apiBasePath.length).replace(/^\/+/, "");
      try {
        if (request.method === "GET" && route === "bootstrap") {
          return config.bootstrap ? jsonResponse(createPublicWorkbenchBootstrap(config.bootstrap)) : jsonResponse({ error: "bootstrap-not-configured" }, 404);
        }
        if (request.method === "GET" && route === "vaults") {
          return jsonResponse({ vaults: [...vaults.values()].map((vault) => ({ id: vault.id })) });
        }
        if (request.method === "GET" && route === "roots") {
          return jsonResponse({ roots: [...roots.values()].map((root) => ({
            capabilities: root.readOnly ? ["file:read"] : ["file:read", "file:write"],
            id: root.id,
            kind: root.kind
          })) });
        }
        const vaultFileMatch = route.match(/^(vaults|roots)\/([^/]+)\/file$/);
        if (vaultFileMatch) {
          const rootCollection = vaultFileMatch[1] === "roots" ? roots : vaults;
          const vault = rootCollection.get(decodeURIComponent(vaultFileMatch[2]));
          if (!vault)
            return jsonResponse({ error: vaultFileMatch[1] === "roots" ? "root-not-found" : "vault-not-found" }, 404);
          const requestedPath = url.searchParams.get("path");
          if (!requestedPath)
            return jsonResponse({ error: "missing-path" }, 400);
          if (vault.readOnly && (request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE"))
            return jsonResponse({ error: "root-read-only" }, 403);
          const resolved = await resolveVaultPath(vault, requestedPath);
          if (!resolved)
            return jsonResponse({ error: "invalid-path" }, 400);
          if (vault.kind === "repository" && !await isRepositoryPathVisible(resolved))
            return jsonResponse({ error: "file-not-found" }, 404);
          if (request.method === "GET")
            return await readVaultFile(resolved, url.searchParams.has("raw"));
          if (request.method === "HEAD")
            return await inspectVaultFile(resolved);
          if (request.method === "PUT")
            return await withPathWriteLock(writeLocks, resolved.path, () => withFileWriteLock(resolved.path, () => writeVaultFileRequest(request, resolved)));
          if (request.method === "PATCH") {
            const prepared = await prepareVaultFileRename(request, resolved);
            if (prepared instanceof Response)
              return prepared;
            const paths = [resolved.path, prepared.target.path];
            return await withPathWriteLocks(writeLocks, paths, () => withFileWriteLocks(paths, () => renameVaultFile(prepared, resolved)));
          }
          if (request.method === "DELETE")
            return await withPathWriteLock(writeLocks, resolved.path, () => withFileWriteLock(resolved.path, () => deleteVaultFile(resolved)));
        }
        const rasterCacheMatch = route.match(/^(vaults|roots)\/([^/]+)\/raster-cache\/([a-f0-9]{64})\.(png|webp)$/);
        if (rasterCacheMatch) {
          const rootCollection = rasterCacheMatch[1] === "roots" ? roots : vaults;
          const vault = rootCollection.get(decodeURIComponent(rasterCacheMatch[2]));
          if (!vault)
            return jsonResponse({ error: rasterCacheMatch[1] === "roots" ? "root-not-found" : "vault-not-found" }, 404);
          const key = rasterCacheMatch[3];
          const format = rasterCacheMatch[4];
          if (request.method === "GET")
            return await readRasterCacheTile(vault, key, format);
          if (request.method === "PUT") {
            if (!isSameOriginRequest(request, url))
              return jsonResponse({ error: "forbidden" }, 403);
            return await writeRasterCacheTile(request, vault, key, format);
          }
        }
        if (request.method === "GET") {
          const vaultFilesMatch = route.match(/^(vaults|roots)\/([^/]+)\/files$/);
          if (vaultFilesMatch) {
            const rootCollection = vaultFilesMatch[1] === "roots" ? roots : vaults;
            const vault = rootCollection.get(decodeURIComponent(vaultFilesMatch[2]));
            if (!vault)
              return jsonResponse({ error: vaultFilesMatch[1] === "roots" ? "root-not-found" : "vault-not-found" }, 404);
            const requestedPath = url.searchParams.get("path") ?? ".";
            const resolved = await resolveVaultPath(vault, requestedPath);
            if (!resolved)
              return jsonResponse({ error: "invalid-path" }, 400);
            if (vault.kind === "repository" && !await isRepositoryPathVisible(resolved))
              return jsonResponse({ error: "file-not-found" }, 404);
            return await listVaultFiles(resolved, url.searchParams.get("lineCounts") === "true");
          }
        }
        return jsonResponse({ error: "not-found" }, 404);
      } catch (error) {
        if (isNotFoundError(error))
          return jsonResponse({ error: "file-not-found" }, 404);
        if (isPathConflictError(error))
          return jsonResponse({ error: "file-conflict" }, 409);
        return jsonResponse({ error: "server-error" }, 500);
      }
    }
  };
}
function resolveCanonicalPath(path) {
  const missingSegments = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return resolve(realpathSync(candidate), ...missingSegments.reverse());
    } catch (error) {
      if (!isNotFoundError(error))
        throw error;
      const parent = dirname2(candidate);
      if (parent === candidate)
        throw error;
      missingSegments.push(basename2(candidate));
      candidate = parent;
    }
  }
}
function createPublicWorkbenchBootstrap(bootstrap) {
  const sources = bootstrap.sources.map(createPublicWorkbenchSource).filter((source) => source !== null);
  return {
    authority: {
      authorityEpoch: bootstrap.authority.authorityEpoch,
      gatewayId: bootstrap.authority.gatewayId,
      gatewayKind: bootstrap.authority.gatewayKind,
      realmId: bootstrap.authority.realmId,
      sourceId: bootstrap.authority.sourceId,
      sourceKind: bootstrap.authority.sourceKind
    },
    ...bootstrap.initialView ? {
      initialView: {
        resource: {
          kind: "bench-file",
          path: bootstrap.initialView.resource.path,
          vaultId: bootstrap.initialView.resource.vaultId
        },
        sourceId: bootstrap.initialView.sourceId
      }
    } : {},
    sources,
    workspace: {
      id: bootstrap.workspace.id,
      name: bootstrap.workspace.name
    }
  };
}
function createPublicWorkbenchSource(source) {
  if (source.kind === "bench-files") {
    return {
      capabilities: [...source.capabilities],
      id: source.id,
      kind: source.kind,
      label: source.label,
      status: source.status,
      vaultIds: [...source.vaultIds]
    };
  }
  if (source.kind === "agents") {
    return {
      capabilities: [...source.capabilities],
      id: source.id,
      kind: source.kind,
      label: source.label,
      status: source.status
    };
  }
  return null;
}
async function readVaultFile(resolved, raw = false) {
  const info = await stat(resolved.path);
  if (raw) {
    const content2 = await readFile(resolved.path);
    return new Response(content2, {
      headers: {
        "cache-control": "no-store",
        "content-type": contentTypeForPath(resolved.path),
        etag: createEtag(info)
      }
    });
  }
  const content = await readFile(resolved.path, "utf8");
  return jsonResponse({ content, etag: createEtag(info), path: vaultRelativePath(resolved) });
}
async function inspectVaultFile(resolved) {
  const info = await stat(resolved.path);
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      "content-type": contentTypeForPath(resolved.path),
      etag: createEtag(info)
    }
  });
}
async function writeVaultFileRequest(request, resolved) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("application/json")) {
    const content = new Uint8Array(await request.arrayBuffer());
    await mkdir2(dirname2(resolved.path), { recursive: true });
    await writeFile(resolved.path, content);
    const nextInfo2 = await stat(resolved.path);
    return jsonResponse({ etag: createEtag(nextInfo2), path: vaultRelativePath(resolved) });
  }
  const body = await request.json();
  if (typeof body.content !== "string")
    return jsonResponse({ error: "invalid-content" }, 400);
  if (body.baseContent !== undefined && typeof body.baseContent !== "string")
    return jsonResponse({ error: "invalid-base-content" }, 400);
  if (body.baseEtag !== undefined && body.baseEtag !== null && typeof body.baseEtag !== "string")
    return jsonResponse({ error: "invalid-base-etag" }, 400);
  if (typeof body.baseContent === "string" && typeof body.baseEtag !== "string")
    return jsonResponse({ error: "missing-base-etag" }, 400);
  if (body.baseEtag === null) {
    await mkdir2(dirname2(resolved.path), { recursive: true });
    try {
      const handle = await open(resolved.path, "wx");
      try {
        await handle.writeFile(body.content);
      } finally {
        await handle.close();
      }
      const nextInfo2 = await stat(resolved.path);
      return jsonResponse({ etag: createEtag(nextInfo2), path: vaultRelativePath(resolved) });
    } catch (error) {
      if (!(error && typeof error === "object" && ("code" in error) && error.code === "EEXIST"))
        throw error;
      const currentInfo2 = await stat(resolved.path).catch(() => null);
      return jsonResponse({ currentEtag: currentInfo2 ? createEtag(currentInfo2) : null, error: "etag-conflict" }, 409);
    }
  }
  const currentInfo = await stat(resolved.path).catch((error) => {
    if (isNotFoundError(error))
      return null;
    throw error;
  });
  const currentEtag = currentInfo ? createEtag(currentInfo) : null;
  if (body.baseEtag !== undefined && body.baseEtag !== currentEtag && body.baseContent === undefined) {
    return jsonResponse({ currentEtag, error: "etag-conflict" }, 409);
  }
  let nextContent = body.content;
  let merged = false;
  if (typeof body.baseContent === "string") {
    if (!isBenchDocumentPath(resolved.path) || !currentInfo)
      return jsonResponse({ error: "bench-merge-unavailable" }, 409);
    try {
      const baseDocument = parseBenchDocument(body.baseContent, resolved.path);
      const desiredDocument = parseBenchDocument(body.content, resolved.path);
      let persisted = false;
      for (let attempt = 0;attempt < 3 && !persisted; attempt += 1) {
        const latestInfo = await stat(resolved.path);
        const currentContent = await readFile(resolved.path, "utf8");
        const result = mergeBenchDocuments(baseDocument, desiredDocument, parseBenchDocument(currentContent, resolved.path));
        if (result.conflicts.length)
          return jsonResponse({ conflicts: result.conflicts, currentEtag: createEtag(latestInfo), error: "bench-merge-conflict" }, 409);
        nextContent = stringifyBenchDocument(result.document, resolved.path);
        merged = currentContent !== body.baseContent;
        persisted = await atomicWriteTextFile(resolved.path, nextContent, currentContent, latestInfo.mode);
      }
      if (!persisted)
        return jsonResponse({ error: "bench-write-race" }, 409);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && /Bench document|Bench records|Duplicate bench| at line \d+,\d+ >>>/.test(error.message)) {
        return jsonResponse({ error: "invalid-bench-content" }, 400);
      }
      throw error;
    }
  } else {
    await mkdir2(dirname2(resolved.path), { recursive: true });
    await writeFile(resolved.path, nextContent);
  }
  const nextInfo = await stat(resolved.path);
  return jsonResponse({ ...typeof body.baseContent === "string" ? { content: nextContent, merged } : {}, etag: createEtag(nextInfo), path: vaultRelativePath(resolved) });
}
async function withPathWriteLock(locks, path, action) {
  const previous = locks.get(path) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve2) => {
    release = resolve2;
  });
  const held = previous.then(() => current);
  locks.set(path, held);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(path) === held)
      locks.delete(path);
  }
}
async function withPathWriteLocks(locks, paths, action) {
  const orderedPaths = [...new Set(paths)].sort();
  const acquire = (index) => index === orderedPaths.length ? action() : withPathWriteLock(locks, orderedPaths[index], () => acquire(index + 1));
  return acquire(0);
}
async function withFileWriteLocks(paths, action) {
  const orderedPaths = [...new Set(paths)].sort();
  const acquire = (index) => index === orderedPaths.length ? action() : withFileWriteLock(orderedPaths[index], () => acquire(index + 1));
  return acquire(0);
}
async function atomicWriteTextFile(path, content, expectedContent, mode) {
  const temporaryPath = join2(dirname2(path), `.${basename2(path)}.workbench-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode });
    if (await readFile(path, "utf8") !== expectedContent)
      return false;
    await rename(temporaryPath, path);
    return true;
  } finally {
    await rm2(temporaryPath, { force: true });
  }
}
async function prepareVaultFileRename(request, resolved) {
  const body = await request.json();
  if (typeof body.toPath !== "string" || body.toPath.trim() === "")
    return jsonResponse({ error: "missing-target-path" }, 400);
  const target = await resolveVaultPath(resolved.vault, body.toPath);
  if (!target)
    return jsonResponse({ error: "invalid-path" }, 400);
  return { target, toPath: body.toPath };
}
async function renameVaultFile(prepared, resolved) {
  const { target, toPath } = prepared;
  await stat(resolved.path);
  const targetInfo = await stat(target.path).catch((error) => {
    if (isNotFoundError(error))
      return null;
    throw error;
  });
  if (targetInfo)
    return jsonResponse({ error: "file-exists" }, 409);
  await mkdir2(dirname2(target.path), { recursive: true });
  await rename(resolved.path, target.path);
  const nextInfo = await stat(target.path);
  return jsonResponse({ etag: createEtag(nextInfo), path: toPath });
}
async function deleteVaultFile(resolved) {
  await unlink(resolved.path);
  return jsonResponse({ path: vaultRelativePath(resolved) });
}
async function listVaultFiles(resolved, includeLineCounts) {
  const entries = await readdir(resolved.path, { withFileTypes: true });
  const repositoryChildren = resolved.vault.kind === "repository" ? await getRepositoryChildren(resolved.vault.root, vaultRelativePath(resolved)) : undefined;
  const visibleEntries = entries.filter((entry) => repositoryChildren ? repositoryChildren.has(entry.name) : !entry.name.startsWith(".git") && entry.name !== ".bench-cache").sort((left, right) => left.name.localeCompare(right.name));
  const files = await mapWithConcurrency(visibleEntries, 8, async (entry) => {
    const type = entry.isDirectory() ? "directory" : "file";
    const info = await lstat(resolve(resolved.path, entry.name));
    const revision = createEtag(info);
    if (!includeLineCounts || type === "directory" || !entry.isFile() || !isTextFileName(entry.name))
      return { name: entry.name, revision, type };
    const lineCount = await countTextFileLines(resolve(resolved.path, entry.name));
    return { ...lineCount !== undefined ? { lineCount } : {}, name: entry.name, revision, type };
  });
  return jsonResponse({
    files,
    path: vaultRelativePath(resolved)
  });
}
var executeFile = promisify(execFile);
var repositoryIndexCache = new Map;
async function getRepositoryChildren(root, directoryPath) {
  const index = await getRepositoryIndex(root);
  return index.get(directoryPath === "." ? "." : directoryPath) ?? new Set;
}
async function getRepositoryIndex(root) {
  const now = Date.now();
  let cached = repositoryIndexCache.get(root);
  if (!cached || cached.expiresAt <= now) {
    const work = createRepositoryIndex(root);
    cached = { expiresAt: now + 1000, work };
    repositoryIndexCache.set(root, cached);
    work.catch(() => {
      if (repositoryIndexCache.get(root)?.work === work)
        repositoryIndexCache.delete(root);
    });
  }
  return await cached.work;
}
async function isRepositoryPathVisible(resolved) {
  const relativePath = vaultRelativePath(resolved);
  if (relativePath === ".")
    return true;
  const separatorIndex = relativePath.lastIndexOf("/");
  const parentPath = separatorIndex < 0 ? "." : relativePath.slice(0, separatorIndex);
  const name = separatorIndex < 0 ? relativePath : relativePath.slice(separatorIndex + 1);
  return (await getRepositoryIndex(resolved.vault.root)).get(parentPath)?.has(name) === true;
}
async function createRepositoryIndex(root) {
  const { stdout } = await executeFile("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  const paths = stdout.toString("utf8").split("\x00").filter((path) => path && !isSensitiveRepositoryPath(path));
  const index = new Map;
  for (const path of paths) {
    const parts = path.split("/");
    for (let depth = 0;depth < parts.length; depth += 1) {
      const parent = depth === 0 ? "." : parts.slice(0, depth).join("/");
      const children = index.get(parent) ?? new Set;
      children.add(parts[depth]);
      index.set(parent, children);
    }
  }
  return index;
}
function isSensitiveRepositoryPath(path) {
  return path.split("/").some((part) => /^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part));
}
var maximumReportedLineCount = 1000;
var maximumScannedTextBytes = 1024 * 1024;
var lineCountCache = new Map;
var textFileExtensions = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".cjs",
  ".clj",
  ".cljs",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".edn",
  ".erl",
  ".ex",
  ".exs",
  ".fish",
  ".fs",
  ".fsx",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hjson",
  ".hpp",
  ".hrl",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh"
]);
var textFileNames = new Set(["dockerfile", "license", "makefile", "readme"]);
function isTextFileName(path) {
  return textFileExtensions.has(extname(path).toLowerCase()) || textFileNames.has(basename2(path).toLowerCase());
}
async function countTextFileLines(path) {
  try {
    const info = await stat(path);
    const cached = lineCountCache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size)
      return cached.lineCount;
    const handle = await open(path, "r");
    let lineCount;
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytesScanned = 0;
      let newlineCount = 0;
      let lastByte;
      while (newlineCount < maximumReportedLineCount && bytesScanned < maximumScannedTextBytes) {
        const bytesToRead = Math.min(buffer.length, maximumScannedTextBytes - bytesScanned);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, null);
        if (bytesRead === 0)
          break;
        bytesScanned += bytesRead;
        for (let index = 0;index < bytesRead; index += 1) {
          const byte = buffer[index];
          if (byte === 0) {
            newlineCount = -1;
            break;
          }
          if (byte === 10)
            newlineCount += 1;
          lastByte = byte;
          if (newlineCount >= maximumReportedLineCount)
            break;
        }
        if (newlineCount < 0)
          break;
      }
      lineCount = newlineCount < 0 ? undefined : newlineCount >= maximumReportedLineCount ? maximumReportedLineCount : info.size > bytesScanned ? undefined : Math.min(maximumReportedLineCount, newlineCount + (lastByte === undefined || lastByte === 10 ? 0 : 1));
    } finally {
      await handle.close();
    }
    lineCountCache.set(path, { lineCount, mtimeMs: info.mtimeMs, size: info.size });
    if (lineCountCache.size > 1e4)
      lineCountCache.delete(lineCountCache.keys().next().value);
    return lineCount;
  } catch {
    return;
  }
}
async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  }));
  return results;
}
async function resolveVaultPath(vault, requestedPath) {
  if (requestedPath.startsWith("/") || requestedPath.includes("\x00"))
    return null;
  const root = resolve(vault.root);
  const path = resolve(root, requestedPath);
  const relativePath = relative(root, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`))
    return null;
  if (relativePath.split(sep)[0] === ".bench-cache")
    return null;
  if (relativePath === "")
    return { path, vault };
  let candidate = root;
  for (const segment of relativePath.split(sep)) {
    candidate = resolve(candidate, segment);
    try {
      if ((await lstat(candidate)).isSymbolicLink())
        return null;
    } catch (error) {
      if (isNotFoundError(error))
        break;
      throw error;
    }
  }
  return { path, vault };
}
function vaultRelativePath(resolved) {
  const relativePath = relative(resolved.vault.root, resolved.path);
  return relativePath === "" ? "." : relativePath.split(sep).join("/");
}
function createEtag(info) {
  return `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${info.ctimeMs?.toString(16) ?? "0"}-${info.ino?.toString(16) ?? "0"}"`;
}
function contentTypeForPath(path) {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png"))
    return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerPath.endsWith(".gif"))
    return "image/gif";
  if (lowerPath.endsWith(".webp"))
    return "image/webp";
  if (lowerPath.endsWith(".svg"))
    return "image/svg+xml";
  return "application/octet-stream";
}
var maximumRasterCacheTileBytes = 4 * 1024 * 1024;
var maximumRasterDimension = 2048;
var rasterCacheWriteLocks = new Map;
var rasterCacheStates = new Map;
function getDefaultRasterCacheRoot(vaultRoot) {
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || join2(homedir(), ".cache");
  const vaultHash = createHash("sha256").update(vaultRoot).digest("hex").slice(0, 24);
  return join2(cacheHome, "klivcore-workbench", "vaults", vaultHash);
}
function getRasterCacheTilePath(vault, key, format) {
  const vaultNamespace = createHash("sha256").update(vault.id).digest("hex").slice(0, 24);
  return join2(vault.cacheRoot, "raster-v1", vaultNamespace, key.slice(0, 2), `${key}.${format}`);
}
async function readRasterCacheTile(vault, key, format) {
  const path = getRasterCacheTilePath(vault, key, format);
  const state = await getRasterCacheState(vault.cacheRoot);
  const info = await stat(path);
  if (info.size <= 0 || info.size > maximumRasterCacheTileBytes) {
    await unlink(path).catch(() => {
      return;
    });
    deleteRasterCacheStateFile(state, path);
    return jsonResponse({ error: "raster-cache-miss" }, 404);
  }
  const content = await readFile(path);
  const dimensions = getRasterCacheDimensions(content, format);
  if (!dimensions || dimensions.width > maximumRasterDimension || dimensions.height > maximumRasterDimension) {
    await unlink(path).catch(() => {
      return;
    });
    deleteRasterCacheStateFile(state, path);
    return jsonResponse({ error: "raster-cache-miss" }, 404);
  }
  const now = new Date;
  await withRasterCacheWriteLock(vault.cacheRoot, async () => {
    const currentInfo = await stat(path).catch((error) => {
      if (isNotFoundError(error))
        return;
      throw error;
    });
    if (!currentInfo) {
      deleteRasterCacheStateFile(state, path);
      return;
    }
    await utimes(path, now, now).catch(() => {
      return;
    });
    setRasterCacheStateFile(state, path, { lastUsed: now.getTime(), size: currentInfo.size });
  });
  return new Response(content, {
    headers: {
      "cache-control": "no-store",
      "content-type": format === "png" ? "image/png" : "image/webp"
    }
  });
}
async function writeRasterCacheTile(request, vault, key, format) {
  const expectedContentType = format === "png" ? "image/png" : "image/webp";
  if (request.headers.get("content-type")?.split(";", 1)[0] !== expectedContentType)
    return jsonResponse({ error: "invalid-raster-content-type" }, 415);
  const declaredSize = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredSize) || declaredSize < 0 || declaredSize > maximumRasterCacheTileBytes)
    return jsonResponse({ error: "raster-tile-too-large" }, 413);
  const content = await readBoundedRequestBody(request, Math.min(maximumRasterCacheTileBytes, vault.cacheMaxBytes));
  if (!content)
    return jsonResponse({ error: "raster-tile-too-large" }, 413);
  if (content.byteLength === 0 || content.byteLength > maximumRasterCacheTileBytes || content.byteLength > vault.cacheMaxBytes)
    return jsonResponse({ error: "raster-tile-too-large" }, 413);
  const dimensions = getRasterCacheDimensions(content, format);
  if (!dimensions)
    return jsonResponse({ error: "invalid-raster-content" }, 400);
  if (dimensions.width > maximumRasterDimension || dimensions.height > maximumRasterDimension)
    return jsonResponse({ error: "raster-dimensions-too-large" }, 413);
  const path = getRasterCacheTilePath(vault, key, format);
  await withRasterCacheWriteLock(vault.cacheRoot, async () => {
    const state = await getRasterCacheState(vault.cacheRoot);
    await mkdir2(dirname2(path), { recursive: true });
    await enforceRasterCacheBudget(state, vault.cacheMaxBytes, content.byteLength, path);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content);
      await rename(temporaryPath, path);
      setRasterCacheStateFile(state, path, { lastUsed: Date.now(), size: content.byteLength });
    } catch (error) {
      await unlink(temporaryPath).catch(() => {
        return;
      });
      throw error;
    }
  });
  return emptyResponse(204);
}
function getRasterCacheDimensions(content, format) {
  if (format === "png") {
    if (content.length < 45 || content[0] !== 137 || content[1] !== 80 || content[2] !== 78 || content[3] !== 71 || content[4] !== 13 || content[5] !== 10 || content[6] !== 26 || content[7] !== 10)
      return;
    let offset2 = 8;
    let dimensions;
    let hasImageData = false;
    let chunkIndex = 0;
    while (offset2 + 12 <= content.length) {
      const length = readUint32BigEndian(content, offset2);
      const chunkEnd = offset2 + 12 + length;
      if (!Number.isSafeInteger(chunkEnd) || chunkEnd > content.length)
        return;
      const type = String.fromCharCode(content[offset2 + 4], content[offset2 + 5], content[offset2 + 6], content[offset2 + 7]);
      if (chunkIndex === 0) {
        if (type !== "IHDR" || length !== 13)
          return;
        dimensions = { height: readUint32BigEndian(content, offset2 + 12), width: readUint32BigEndian(content, offset2 + 8) };
        if (dimensions.width <= 0 || dimensions.height <= 0)
          return;
      } else if (type === "IHDR")
        return;
      if (type === "IDAT")
        hasImageData = hasImageData || length > 0;
      offset2 = chunkEnd;
      chunkIndex += 1;
      if (type === "IEND")
        return length === 0 && hasImageData && offset2 === content.length ? dimensions : undefined;
    }
    return;
  }
  if (content.length < 30 || content[0] !== 82 || content[1] !== 73 || content[2] !== 70 || content[3] !== 70 || content[8] !== 87 || content[9] !== 69 || content[10] !== 66 || content[11] !== 80 || readUint32LittleEndian(content, 4) !== content.length - 8)
    return;
  let offset = 12;
  let extendedDimensions;
  while (offset + 8 <= content.length) {
    const chunk = String.fromCharCode(content[offset], content[offset + 1], content[offset + 2], content[offset + 3]);
    const length = readUint32LittleEndian(content, offset + 4);
    const payload = offset + 8;
    const chunkEnd = payload + length;
    const paddedEnd = chunkEnd + (length & 1);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > content.length)
      return;
    if (chunk === "VP8X") {
      if (length !== 10)
        return;
      extendedDimensions = { height: 1 + readUint24LittleEndian(content, payload + 7), width: 1 + readUint24LittleEndian(content, payload + 4) };
    }
    if (chunk === "VP8L" && length >= 5 && content[payload] === 47) {
      const dimensions = { height: 1 + (content[payload + 2] >> 6 | content[payload + 3] << 2 | (content[payload + 4] & 15) << 10), width: 1 + (content[payload + 1] | (content[payload + 2] & 63) << 8) };
      return paddedEnd === content.length && (!extendedDimensions || extendedDimensions.width === dimensions.width && extendedDimensions.height === dimensions.height) ? dimensions : undefined;
    }
    if (chunk === "VP8 " && length >= 10 && content[payload + 3] === 157 && content[payload + 4] === 1 && content[payload + 5] === 42) {
      const dimensions = { height: (content[payload + 8] | content[payload + 9] << 8) & 16383, width: (content[payload + 6] | content[payload + 7] << 8) & 16383 };
      return dimensions.width > 0 && dimensions.height > 0 && paddedEnd === content.length && (!extendedDimensions || extendedDimensions.width === dimensions.width && extendedDimensions.height === dimensions.height) ? dimensions : undefined;
    }
    offset = paddedEnd;
  }
  return;
}
async function readBoundedRequestBody(request, maximumBytes) {
  if (!request.body)
    return new Uint8Array;
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}
function readUint32BigEndian(content, offset) {
  return content[offset] * 16777216 + (content[offset + 1] << 16) + (content[offset + 2] << 8) + content[offset + 3];
}
function readUint24LittleEndian(content, offset) {
  return content[offset] | content[offset + 1] << 8 | content[offset + 2] << 16;
}
function readUint32LittleEndian(content, offset) {
  return (content[offset] | content[offset + 1] << 8 | content[offset + 2] << 16 | content[offset + 3] << 24) >>> 0;
}
async function withRasterCacheWriteLock(cacheRoot, work) {
  const previous = rasterCacheWriteLocks.get(cacheRoot) ?? Promise.resolve();
  const current = previous.catch(() => {
    return;
  }).then(work);
  rasterCacheWriteLocks.set(cacheRoot, current);
  try {
    await current;
  } finally {
    if (rasterCacheWriteLocks.get(cacheRoot) === current)
      rasterCacheWriteLocks.delete(cacheRoot);
  }
}
async function getRasterCacheState(cacheRoot) {
  let state = rasterCacheStates.get(cacheRoot);
  if (!state) {
    state = { files: new Map, totalBytes: 0 };
    rasterCacheStates.set(cacheRoot, state);
  }
  state.initialization ??= collectRasterCacheFiles(join2(cacheRoot, "raster-v1")).then((files) => {
    state.files = new Map(files.map((file) => [file.path, { lastUsed: file.lastUsed, size: file.size }]));
    state.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  });
  await state.initialization;
  return state;
}
function setRasterCacheStateFile(state, path, file) {
  state.totalBytes += file.size - (state.files.get(path)?.size ?? 0);
  state.files.set(path, file);
}
function deleteRasterCacheStateFile(state, path) {
  state.totalBytes -= state.files.get(path)?.size ?? 0;
  state.files.delete(path);
}
async function enforceRasterCacheBudget(state, maxBytes, incomingBytes, targetPath) {
  const replacedBytes = state.files.get(targetPath)?.size ?? 0;
  let excessBytes = state.totalBytes - replacedBytes + incomingBytes - maxBytes;
  if (excessBytes <= 0)
    return;
  const files = [...state.files].sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  for (const [path, file] of files) {
    if (path === targetPath)
      continue;
    await unlink(path).catch((error) => {
      if (!isNotFoundError(error))
        throw error;
    });
    deleteRasterCacheStateFile(state, path);
    excessBytes -= file.size;
    if (excessBytes <= 0)
      return;
  }
}
async function collectRasterCacheFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (isNotFoundError(error))
      return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const path = join2(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRasterCacheFiles(path));
      continue;
    }
    if (!entry.isFile())
      continue;
    if (entry.name.endsWith(".tmp")) {
      await unlink(path).catch(() => {
        return;
      });
      continue;
    }
    const info = await stat(path);
    files.push({ lastUsed: info.mtimeMs, path, size: info.size });
  }
  return files;
}
function normalizeApiBasePath(path) {
  return path.replace(/\/+$/, "");
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    },
    status
  });
}
function emptyResponse(status) {
  return new Response(null, { status });
}
function isSameOriginRequest(request, url) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin)
    return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "none" || fetchSite === "same-origin";
}
function isNotFoundError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isPathConflictError(error) {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "EISDIR" || error.code === "ENOTDIR");
}

// packages/publish-sdk/src/gateway-server-core.ts
var bootstrap = {
  authority: {
    authorityEpoch: "workbench-gateway-v1",
    gatewayId: "workbench",
    gatewayKind: "resource",
    realmId: "gateway",
    sourceId: "workbench-vault",
    sourceKind: "bench-files"
  },
  initialView: { resource: { kind: "bench-file", path: "main.bench.json", vaultId: "main" }, sourceId: "workbench-vault" },
  sources: [{ capabilities: ["file:read", "file:write"], id: "workbench-vault", kind: "bench-files", label: "Workbench", status: "connected", vaultIds: ["main"] }],
  workspace: { id: "workbench", name: "Acme modular Workbench" }
};
var mainBench = Object.freeze({
  name: "Acme modular Workbench",
  elements: Object.freeze([
    Object.freeze({ id: "text:architecture", type: "text", value: `# Native Workbench

Text, text-file, image, and recursively nested bench elements are implemented by Workbench itself.`, x: 40, y: 40, w: 520, h: 220 }),
    Object.freeze({ id: "text-file:readme", type: "text-file", path: "notes/readme.md", x: 600, y: 40, w: 560, h: 320 }),
    Object.freeze({ id: "image:modularity", type: "image", path: "assets/modularity.svg", x: 40, y: 320, w: 520, h: 320 }),
    Object.freeze({ id: "bench:child", type: "bench", path: "nested/child.bench.json", x: 600, y: 400, w: 640, h: 420 })
  ]),
  edges: Object.freeze([])
});
var childBench = Object.freeze({
  name: "Nested child bench",
  elements: Object.freeze([
    Object.freeze({ id: "text:child", type: "text", value: "Nested child bench", x: 40, y: 40, w: 320, h: 180 }),
    Object.freeze({ id: "bench:grandchild", type: "bench", path: "nested/grandchild.bench.json", x: 400, y: 40, w: 520, h: 320 })
  ]),
  edges: Object.freeze([])
});
var grandchildBench = Object.freeze({
  name: "Nested grandchild bench",
  elements: Object.freeze([
    Object.freeze({ id: "text:grandchild", type: "text", value: "Recursive native bench loading works.", x: 40, y: 40, w: 420, h: 180 })
  ]),
  edges: Object.freeze([])
});
var modularitySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Native image element"><rect width="640" height="360" rx="28" fill="#0f172a"/><rect x="56" y="78" width="220" height="204" rx="20" fill="#164e63" stroke="#22d3ee" stroke-width="6"/><rect x="364" y="78" width="220" height="204" rx="20" fill="#14532d" stroke="#4ade80" stroke-width="6"/><path d="M276 180h88" stroke="#e2e8f0" stroke-width="8"/><text x="320" y="44" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#e2e8f0">Native image element</text><text x="166" y="190" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#cffafe">Workbench</text><text x="474" y="190" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#dcfce7">Realm</text></svg>
`;
var VAULT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
var BENCH_PATH = /^[^/\\](?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).*\.bench\.(?:h?json)$/u;
function parseWorkbenchGatewayConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Workbench Gateway config is invalid");
  const config = value;
  const keys = Object.keys(config).sort().join("\x00");
  if (typeof config.workspaceName !== "string" || config.workspaceName.trim() === "" || config.workspaceName.length > 128) {
    throw new TypeError("Workbench Gateway config is invalid");
  }
  if (keys === ["initialView", "vaultRoot", "workspaceName"].sort().join("\x00")) {
    if (typeof config.vaultRoot !== "string" || !isAbsolute(config.vaultRoot) || typeof config.initialView !== "string" || !BENCH_PATH.test(config.initialView)) {
      throw new TypeError("Workbench Gateway config is invalid");
    }
    return Object.freeze({
      initialView: Object.freeze({ path: config.initialView, vaultId: "main" }),
      vaults: Object.freeze([Object.freeze({ id: "main", root: resolve2(config.vaultRoot) })]),
      workspaceName: config.workspaceName
    });
  }
  if (keys !== ["initialView", "vaults", "workspaceName"].sort().join("\x00") || !config.initialView || typeof config.initialView !== "object" || Array.isArray(config.initialView) || !Array.isArray(config.vaults) || config.vaults.length === 0 || config.vaults.length > 100) {
    throw new TypeError("Workbench Gateway config is invalid");
  }
  const initialView = config.initialView;
  if (Object.keys(initialView).sort().join("\x00") !== ["path", "vaultId"].sort().join("\x00") || typeof initialView.path !== "string" || !BENCH_PATH.test(initialView.path) || typeof initialView.vaultId !== "string" || !VAULT_ID.test(initialView.vaultId)) {
    throw new TypeError("Workbench Gateway config is invalid");
  }
  const seen = new Set;
  const vaults = config.vaults.map((value2) => {
    if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
      throw new TypeError("Workbench Gateway config is invalid");
    const vault = value2;
    if (Object.keys(vault).sort().join("\x00") !== ["id", "root"].sort().join("\x00") || typeof vault.id !== "string" || !VAULT_ID.test(vault.id) || seen.has(vault.id) || typeof vault.root !== "string" || !isAbsolute(vault.root)) {
      throw new TypeError("Workbench Gateway config is invalid");
    }
    seen.add(vault.id);
    return Object.freeze({ id: vault.id, root: resolve2(vault.root) });
  });
  if (!seen.has(initialView.vaultId))
    throw new TypeError("Workbench Gateway config is invalid");
  return Object.freeze({
    initialView: Object.freeze({ path: initialView.path, vaultId: initialView.vaultId }),
    vaults: Object.freeze(vaults),
    workspaceName: config.workspaceName
  });
}
function normalizeWorkbenchGatewayConfig(configured) {
  return "vaultRoot" in configured ? parseWorkbenchGatewayConfig(configured) : configured;
}
async function createWorkbenchGatewayHandler(homePath, configured, debugAssetsPath, publishedDebugCategoryIds = []) {
  const home = resolve2(homePath);
  const cache = resolve2(home, "cache");
  const effectiveConfig = configured ? normalizeWorkbenchGatewayConfig(configured) : undefined;
  const defaultVault = resolve2(home, "vault");
  const vaults = effectiveConfig?.vaults ?? [{ id: "main", root: defaultVault }];
  if (effectiveConfig) {
    await Promise.all(vaults.map(async (vault) => {
      const info = await lstat2(vault.root);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new TypeError(`Workbench Gateway vault root is invalid: ${vault.id}`);
    }));
  } else {
    await mkdir3(defaultVault, { recursive: true, mode: 448 });
  }
  await mkdir3(cache, { recursive: true, mode: 448 });
  await chmod(home, 448);
  if (!effectiveConfig) {
    await Promise.all([
      seed(resolve2(defaultVault, "main.bench.json"), `${JSON.stringify(mainBench, null, 2)}
`),
      seed(resolve2(defaultVault, "notes/readme.md"), `# Acme Workbench

This native text-file element is backed by the isolated Workbench Gateway vault.
`),
      seed(resolve2(defaultVault, "assets/modularity.svg"), modularitySvg),
      seed(resolve2(defaultVault, "nested/child.bench.json"), `${JSON.stringify(childBench, null, 2)}
`),
      seed(resolve2(defaultVault, "nested/grandchild.bench.json"), `${JSON.stringify(grandchildBench, null, 2)}
`)
    ]);
  }
  const effectiveBootstrap = effectiveConfig ? {
    ...bootstrap,
    initialView: { resource: { kind: "bench-file", path: effectiveConfig.initialView.path, vaultId: effectiveConfig.initialView.vaultId }, sourceId: "workbench-vault" },
    sources: [{ ...bootstrap.sources[0], vaultIds: vaults.map((vault) => vault.id) }],
    workspace: { id: "workbench", name: effectiveConfig.workspaceName }
  } : bootstrap;
  const server = createWorkbenchServer({ apiBasePath: "/v1", bootstrap: effectiveBootstrap, vaults: vaults.map((vault) => ({ ...vault, cacheRoot: cache })) });
  let debugAssets = new Map;
  if (debugAssetsPath) {
    debugAssets = await openPublishedDebugAssets(resolve2(debugAssetsPath), publishedDebugCategoryIds);
  }
  return requestHandler(server, debugAssets);
}
async function openPublishedDebugAssets(debugAssetsPath, publishedDebugCategoryIds) {
  const opened = new Map;
  const root = await open2(debugAssetsPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => {
    return;
  });
  if (!root)
    throw new TypeError("Workbench Gateway debug asset root is invalid");
  try {
    const rootInfo = await root.stat();
    if (!rootInfo.isDirectory())
      throw new TypeError("Workbench Gateway debug asset root is invalid");
    const categoryIds = new Set;
    for (const categoryId of publishedDebugCategoryIds) {
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(categoryId) || categoryIds.has(categoryId)) {
        throw new TypeError("Workbench Gateway debug category id is invalid");
      }
      categoryIds.add(categoryId);
      for (const extension of ["js", "css"]) {
        const name = `${categoryId}.${extension}`;
        let file = await open2(`/proc/self/fd/${root.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          const maximumBytes = extension === "js" ? 16 * 1024 * 1024 : 4 * 1024 * 1024;
          if (!info.isFile() || info.size > maximumBytes) {
            throw new TypeError(`Workbench Gateway debug asset is invalid: ${name}`);
          }
          opened.set(name, Object.freeze({
            file,
            size: info.size,
            contentType: extension === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8"
          }));
          file = undefined;
        } finally {
          await file?.close().catch(() => {
            return;
          });
        }
      }
    }
    await root.close();
    return opened;
  } catch (error) {
    await Promise.all([root.close().catch(() => {
      return;
    }), ...[...opened.values()].map(({ file }) => file.close().catch(() => {
      return;
    }))]);
    throw error;
  }
}
async function readPublishedDebugAsset(asset) {
  const buffer = new ArrayBuffer(asset.size);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await asset.file.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0)
      throw new Error("Workbench Gateway debug asset ended unexpectedly");
    offset += bytesRead;
  }
  return buffer;
}
function requestHandler(server, debugAssets) {
  let closed = false;
  const handler = async (request) => {
    if (closed)
      return new Response("Gateway closed", { status: 503 });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && !url.search)
      return Response.json({ status: "ok", gateway: "workbench-v1" });
    const debugMatch = request.method === "GET" && !url.search ? /^\/v1\/debug\/assets\/([a-z0-9][a-z0-9-]{0,127})\.(js|css)$/u.exec(url.pathname) : null;
    if (debugMatch) {
      const asset = debugAssets.get(`${debugMatch[1]}.${debugMatch[2]}`);
      if (!asset)
        return new Response("Not found", { status: 404 });
      return new Response(await readPublishedDebugAsset(asset), {
        headers: {
          "cache-control": "no-store",
          "content-type": asset.contentType,
          "x-content-type-options": "nosniff"
        }
      });
    }
    return server.fetch(request);
  };
  return Object.assign(handler, {
    async close() {
      if (closed)
        return;
      closed = true;
      await Promise.all([...debugAssets.values()].map(({ file }) => file.close().catch(() => {
        return;
      })));
    }
  });
}
async function seed(path, content) {
  await mkdir3(dirname3(path), { recursive: true, mode: 448 });
  try {
    await writeFile2(path, content, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
}

// packages/react/src/debugContributions.ts
var workbenchReactDebugContributions = Object.freeze([
  Object.freeze({
    debugId: "bench-viewport",
    description: "Pan and zoom mock scenarios for tuning workbench viewport controls.",
    name: "Bench viewport",
    scenarioIds: Object.freeze(["rgb-squares", "textareas", "comments", "agent-quick-access", "comment-parenting", "lod-validation", "stress-1k", "stress-10k", "stress-100k", "stress-1m", "stress-textareas-1k", "stress-textareas-10k", "stress-textareas-100k", "stress-textareas-1m"])
  }),
  Object.freeze({
    debugId: "directory-scene",
    description: "Recursive resource geometry, traversal identity, empty roots, and bounded wide-tree projection.",
    name: "Directory scene",
    scenarioIds: Object.freeze(["recursive-treemap", "repeated-traversal", "multi-root-fixture", "empty-root", "real-workspace", "multi-root-workspace", "wide-1000", "weighted-code-1000"])
  }),
  Object.freeze({
    debugId: "edge",
    description: "Focused scenarios for workbench edge handles, slots, routing, and editing.",
    name: "Edges",
    scenarioIds: Object.freeze(["labels", "slot-sides", "slot-indices", "nearest-and-groups", "raw-position", "mixed-graph"])
  }),
  Object.freeze({
    debugId: "element-menu",
    description: "Focused scenarios for the add-node menu component.",
    name: "Element menu",
    scenarioIds: Object.freeze(["default-types", "add-existing-nested-bench", "create-new-nested-bench"])
  }),
  Object.freeze({
    debugId: "file-path-input",
    description: "Reusable vault file path input and existing-file picker scenarios.",
    name: "File path input",
    scenarioIds: Object.freeze(["manual-entry", "bench-file-picker", "image-file-picker"])
  }),
  Object.freeze({
    debugId: "physics-layout",
    description: "Isolated container-aware layout physics scenarios with edge-force decomposition controls.",
    name: "Physics layout",
    scenarioIds: Object.freeze(["two-groups-one-edge", "two-groups-many-edges", "triangle-groups", "nested-lca", "packing-vs-anchor", "slot-point-forces", "oscillation-stress", "stress-random-100", "stress-random-250-nested", "stress-single-container-5k", "stress-many-containers-2k", "box2d-single-container-5k", "box2d-many-containers-2k", "stress-random-500-clusters", "stress-random-1k-flat", "stress-random-1k-six-layers", "stress-random-1k-dense", "stress-random-1k-overlap", "stress-random-2k-wide", "stress-random-5k-wide"])
  }),
  Object.freeze({
    debugId: "preview",
    description: "Focused scenarios for generated preview image capture.",
    name: "Preview capture",
    scenarioIds: Object.freeze(["dom-to-jpeg"])
  }),
  Object.freeze({
    debugId: "test-file",
    description: "Focused scenarios for text-file create, rename, validation, and content-save flows.",
    name: "Text file",
    scenarioIds: Object.freeze(["agent-line-highlights", "create-immediate-rename-content", "generated-name-unchanged", "escape-cancel-rename", "existing-target", "new-target-nested", "duplicate-same-path", "path-validation-errors", "path-conflicts", "missing-old-backing-file"])
  }),
  Object.freeze({
    debugId: "voice-comment",
    description: "Deterministic push-to-talk, frozen-anchor, retained-audio, retry, and cancellation behavior.",
    name: "Voice comment",
    scenarioIds: Object.freeze(["push-to-talk"])
  }),
  Object.freeze({
    debugId: "workbench",
    description: "Integrated workbench scenarios backed by real vault files and server APIs.",
    name: "Workbench",
    scenarioIds: Object.freeze(["bootstrap", "bootstrap-main", "main-bench", "nested-bench-basic", "nested-bench-alignment-measure", "nested-bench-spiral-alignment", "nested-bench-zoom-coverage-threshold", "nested-bench-runtime-child-coverage", "nested-bench-random-origin-stress", "nested-bench-return-focus", "nested-bench-empty-default-size", "nested-bench-small-default-size", "jpg-preview-alignment-rgb", "jpg-preview-alignment-rgb-wide", "jpg-preview-alignment-rgb-tall", "jpg-preview-alignment-rgb-offset", "nested-bench-duplicate-instances", "nested-bench-self-recursion", "nested-bench-mutual-recursion", "nested-bench-deep-stack"])
  })
]);

// packages/publish-sdk/src/gateway-debug-publication.ts
var publishedScenarioIdsByCategory = Object.freeze({
  "bench-viewport": Object.freeze(["rgb-squares", "textareas", "comments", "agent-quick-access", "comment-parenting", "lod-validation", "stress-1k", "stress-10k", "stress-100k", "stress-1m", "stress-textareas-1k", "stress-textareas-10k", "stress-textareas-100k", "stress-textareas-1m"]),
  "directory-scene": Object.freeze(["recursive-treemap", "repeated-traversal"])
});
var publishedWorkbenchDebugContributions = Object.freeze(Object.entries(publishedScenarioIdsByCategory).map(([debugId, scenarioIds]) => {
  const contribution = workbenchReactDebugContributions.find((candidate) => candidate.debugId === debugId);
  if (!contribution || scenarioIds.some((scenarioId) => !contribution.scenarioIds.includes(scenarioId))) {
    throw new Error(`published Workbench debug contribution is invalid: ${debugId}`);
  }
  return Object.freeze({
    debugId,
    description: contribution.description,
    name: contribution.name,
    scenarioIds
  });
}));
var publishedWorkbenchDebugCategoryIds = Object.freeze(publishedWorkbenchDebugContributions.map((contribution) => contribution.debugId));

// packages/publish-sdk/src/gateway-server.ts
function requiredAbsolute(name) {
  const value = process.env[name];
  if (!value || !resolve3(value).startsWith("/"))
    throw new Error(`${name} must be absolute`);
  return resolve3(value);
}
function requiredPort() {
  const value = process.env.KLIVCORE_GATEWAY_PORT;
  if (!value || !/^[1-9]\d{0,4}$/u.test(value) || Number(value) > 65535)
    throw new Error("KLIVCORE_GATEWAY_PORT is invalid");
  return Number(value);
}
var home = requiredAbsolute("KLIVCORE_GATEWAY_HOME");
var configPath = requiredAbsolute("KLIVCORE_GATEWAY_CONFIG");
var config = JSON.parse(await readFile2(configPath, "utf8"));
var debugAssets = resolve3(import.meta.dir, "../debug/assets");
var handler = await createWorkbenchGatewayHandler(home, parseWorkbenchGatewayConfig(config), debugAssets, publishedWorkbenchDebugCategoryIds);
var server = Bun.serve({ hostname: "127.0.0.1", port: requiredPort(), fetch: handler });
console.log(`Canonical Workbench Gateway ready on http://127.0.0.1:${server.port}`);
var stopping = false;
async function stop() {
  if (stopping)
    return;
  stopping = true;
  await handler.close();
  server.stop(true);
}
process.once("SIGINT", () => {
  stop();
});
process.once("SIGTERM", () => {
  stop();
});
