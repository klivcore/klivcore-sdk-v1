#!/usr/bin/env bun
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

// scripts/bench-edit.ts
import { createHash as createHash2, randomUUID } from "crypto";
import { link, lstat, mkdtemp, readFile, realpath, rename, rm as rm2, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename as basename2, dirname as dirname2, isAbsolute, join as join2, relative, resolve, sep } from "path";
// packages/core/src/benchMerge.ts
var missing = Symbol("missing");
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
  if (!isRecord(parsed))
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
  if (isRecord(value)) {
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
function isRecord(value) {
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

// scripts/benchEdit.ts
import { createHash } from "crypto";
// ../../repos/klivcore-workbench/packages/core/src/benchMerge.ts
var missing2 = Symbol("missing");
// ../../repos/klivcore-workbench/packages/core/src/benchDocumentFormat.ts
var import_hjson2 = __toESM(require_hjson(), 1);
function getBenchDocumentFormat2(path) {
  const normalized = path.trim().toLowerCase();
  if (normalized.endsWith(".bench.hjson"))
    return "hjson";
  if (normalized.endsWith(".bench.json"))
    return "json";
  return null;
}
function parseHjsonValue2(content) {
  return import_hjson2.default.parse(content, { keepWsc: true });
}
function parseBenchDocument2(content, path) {
  const format = getBenchDocumentFormat2(path);
  const parsed = format === "hjson" ? parseHjsonValue2(content) : JSON.parse(content);
  if (!isRecord2(parsed))
    throw new Error(`Bench document must be an object: ${path}`);
  rejectUnsupportedBenchValues2(parsed, path);
  return parsed;
}
function stringifyBenchDocument2(bench, path) {
  const format = getBenchDocumentFormat2(path);
  if (format === "hjson") {
    rejectUnsupportedBenchValues2(bench, path);
    return `${stringifyHjsonBenchValue2(bench, 0)}
`;
  }
  return `${JSON.stringify(bench, null, 2)}
`;
}
function stringifyHjsonBenchValue2(value, depth) {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (value === null)
    return "null";
  if (typeof value === "string")
    return quoteHjsonString2(value);
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length)
      return "[]";
    return `[
${value.map((child, index) => withHjsonComments2(value, index, indentFirstLine2(addTrailingComma2(stringifyHjsonBenchValue2(child, depth + 1)), childIndent), childIndent)).join(`
`)}
${indent}]`;
  }
  if (isRecord2(value)) {
    const entries = Object.entries(value);
    if (!entries.length)
      return "{}";
    return `{
${entries.map(([key, child]) => {
      const rendered = stringifyHjsonBenchValue2(child, depth + 1);
      const lines = rendered.split(`
`);
      const firstLine = `${childIndent}${formatHjsonKey2(key)}: ${lines[0]}`;
      return withHjsonComments2(value, key, addTrailingComma2([firstLine, ...lines.slice(1)].join(`
`)), childIndent);
    }).join(`
`)}
${indent}}`;
  }
  throw new Error(`Unsupported value in bench document: ${String(value)}`);
}
function indentFirstLine2(value, indent) {
  const lines = value.split(`
`);
  return [indent + lines[0], ...lines.slice(1)].join(`
`);
}
function addTrailingComma2(value) {
  const lines = value.split(`
`);
  lines[lines.length - 1] = `${lines[lines.length - 1]},`;
  return lines.join(`
`);
}
function formatHjsonKey2(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !hjsonReservedKeys2.has(key) ? key : JSON.stringify(key);
}
function quoteHjsonString2(value) {
  const hasSignificantIndentation = value.split(`
`).some((line) => /^[\t ]/.test(line));
  if (value.includes(`
`) && !value.includes("'''") && !hasSignificantIndentation)
    return `'''
${value}
'''`;
  return JSON.stringify(value);
}
var hjsonReservedKeys2 = new Set(["true", "false", "null"]);
function withHjsonComments2(container, key, rendered, indent) {
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
function rejectUnsupportedBenchValues2(value, path, seen = new WeakSet, trace = "$") {
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
      rejectUnsupportedBenchValues2(value[index], path, seen, `${trace}[${index}]`);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`Unsupported non-plain object in bench document ${path} at ${trace}`);
  for (const [key, child] of Object.entries(value))
    rejectUnsupportedBenchValues2(child, path, seen, `${trace}.${key}`);
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
// scripts/benchEdit.ts
function parseBenchEditOperations(value) {
  if (!Array.isArray(value))
    throw new Error("operations must be an array");
  return value.map((candidate, index) => parseBenchEditOperation(candidate, index));
}
function applyBenchOperations(source, operations) {
  assertValidBench(source, "Cannot edit invalid bench");
  const bench = structuredClone(source);
  bench.elements = asRecordArray(bench.elements, "elements");
  bench.edges = asRecordArray(bench.edges, "edges");
  for (const operation of operations) {
    switch (operation.op) {
      case "add-element":
        bench.elements.push(structuredClone(operation.element));
        break;
      case "update-element":
        updateById(bench.elements, operation.id, operation, "element");
        break;
      case "remove-element":
        removeElement(bench, operation.id, operation.cascade === true);
        break;
      case "add-edge":
        bench.edges.push(structuredClone(operation.edge));
        break;
      case "update-edge":
        updateById(bench.edges, operation.id, operation, "edge");
        break;
      case "remove-edge":
        removeById(bench.edges, operation.id, "edge");
        break;
      case "update-document":
        applyPatch(bench, operation.patch, operation.unset);
        break;
      default:
        throw new Error(`Unsupported bench operation: ${JSON.stringify(operation)}`);
    }
  }
  assertValidBench(bench, "Bench edit produced invalid document");
  return bench;
}
function editBenchText(input) {
  const beforeSha256 = sha256(input.content);
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== beforeSha256) {
    throw new Error(`Bench hash mismatch for ${input.path}: expected ${input.expectedSha256.toLowerCase()}, found ${beforeSha256}`);
  }
  const original = parseBenchDocument2(input.content, input.path);
  const document = applyBenchOperations(original, input.operations);
  const content = stringifyBenchDocument2(document, input.path);
  return {
    afterSha256: sha256(content),
    beforeSha256,
    changed: content !== input.content,
    content,
    document,
    summary: input.operations.map(summarizeOperation)
  };
}
function validateBenchDocument(bench) {
  const errors = [];
  const elements = validateRecordArray(bench.elements, "elements", errors);
  const edges = validateRecordArray(bench.edges, "edges", errors);
  const elementIds = collectIds(elements, "element", errors);
  const edgeIds = collectIds(edges, "edge", errors);
  for (const id of edgeIds) {
    if (elementIds.has(id))
      errors.push(`Duplicate document id: ${id}`);
  }
  for (const element of elements) {
    const id = recordId(element, "<missing-id>");
    for (const key of ["x", "y", "w", "h", "width", "height"]) {
      if (key in element && (typeof element[key] !== "number" || !Number.isFinite(element[key]))) {
        errors.push(`Element ${id} has non-finite ${key}`);
      }
    }
    if (element.parentId !== undefined) {
      if (typeof element.parentId !== "string" || !element.parentId)
        errors.push(`Element ${id} has invalid parentId`);
      else if (!elementIds.has(element.parentId))
        errors.push(`Element ${id} references missing parentId: ${element.parentId}`);
      else if (element.parentId === id)
        errors.push(`Element ${id} cannot parent itself`);
    }
  }
  errors.push(...findParentCycles(elements));
  for (const edge of edges) {
    const id = recordId(edge, "<missing-id>");
    validateEdgeEndpoint(edge.from, "from", id, elementIds, errors);
    validateEdgeEndpoint(edge.to, "to", id, elementIds, errors);
  }
  return unique(errors);
}
function assertValidBench(bench, prefix) {
  const errors = validateBenchDocument(bench);
  if (errors.length)
    throw new Error(`${prefix}:
- ${errors.join(`
- `)}`);
}
function validateRecordArray(value, name, errors) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value)) {
    errors.push(`Bench ${name} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    if (!isRecord3(item)) {
      errors.push(`Bench ${name}[${index}] must be an object`);
      return [];
    }
    return [item];
  });
}
function asRecordArray(value, name) {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.some((item) => !isRecord3(item)))
    throw new Error(`Bench ${name} must be an array of objects`);
  return value;
}
function collectIds(records, kind, errors) {
  const ids = new Set;
  for (const [index, record] of records.entries()) {
    if (typeof record.id !== "string" || !record.id) {
      errors.push(`Bench ${kind} at index ${index} has missing or invalid id`);
      continue;
    }
    if (ids.has(record.id))
      errors.push(`Duplicate ${kind} id: ${record.id}`);
    ids.add(record.id);
  }
  return ids;
}
function parseBenchEditOperation(value, index) {
  const prefix = `operations[${index}]`;
  if (!isRecord3(value))
    throw new Error(`${prefix} must be an object`);
  if (typeof value.op !== "string")
    throw new Error(`${prefix}.op must be a string`);
  switch (value.op) {
    case "add-element":
      assertAllowedKeys(value, ["op", "element"], prefix);
      return { op: value.op, element: requireRecord(value.element, `${prefix}.element`) };
    case "add-edge":
      assertAllowedKeys(value, ["op", "edge"], prefix);
      return { op: value.op, edge: requireRecord(value.edge, `${prefix}.edge`) };
    case "update-element":
    case "update-edge": {
      assertAllowedKeys(value, ["op", "id", "patch", "unset"], prefix);
      const id = requireId(value.id, `${prefix}.id`);
      const update = parseUpdate(value, prefix, new Set(["id"]));
      return { op: value.op, id, ...update };
    }
    case "remove-element": {
      assertAllowedKeys(value, ["op", "id", "cascade"], prefix);
      const id = requireId(value.id, `${prefix}.id`);
      if (value.cascade !== undefined && typeof value.cascade !== "boolean")
        throw new Error(`${prefix}.cascade must be a boolean`);
      return value.cascade === undefined ? { op: value.op, id } : { op: value.op, id, cascade: value.cascade };
    }
    case "remove-edge":
      assertAllowedKeys(value, ["op", "id"], prefix);
      return { op: value.op, id: requireId(value.id, `${prefix}.id`) };
    case "update-document": {
      assertAllowedKeys(value, ["op", "patch", "unset"], prefix);
      const update = parseUpdate(value, prefix, new Set(["elements", "edges"]));
      return { op: value.op, ...update };
    }
    default:
      throw new Error(`${prefix}.op is unsupported: ${value.op}`);
  }
}
function parseUpdate(value, prefix, forbiddenKeys) {
  if (value.patch === undefined && value.unset === undefined)
    throw new Error(`${prefix} requires patch or unset`);
  let patch;
  if (value.patch !== undefined) {
    patch = requireRecord(value.patch, `${prefix}.patch`);
    for (const key of Object.keys(patch)) {
      if (forbiddenKeys.has(key) || isDangerousKey(key))
        throw new Error(`${prefix}.patch cannot change ${key}`);
    }
  }
  let unset;
  if (value.unset !== undefined) {
    if (!Array.isArray(value.unset) || value.unset.some((key) => typeof key !== "string" || !key)) {
      throw new Error(`${prefix}.unset must be an array of non-empty strings`);
    }
    unset = value.unset;
    for (const key of unset) {
      if (forbiddenKeys.has(key) || isDangerousKey(key))
        throw new Error(`${prefix}.unset cannot remove ${key}`);
    }
  }
  return {
    ...patch === undefined ? {} : { patch },
    ...unset === undefined ? {} : { unset }
  };
}
function requireRecord(value, path) {
  if (!isRecord3(value))
    throw new Error(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key))
      throw new Error(`${path} contains forbidden key: ${key}`);
  }
  return value;
}
function requireId(value, path) {
  if (typeof value !== "string" || !value)
    throw new Error(`${path} must be a non-empty string`);
  return value;
}
function assertAllowedKeys(value, allowed, path) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected)
    throw new Error(`${path} has unexpected field: ${unexpected}`);
}
function isDangerousKey(key) {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}
function findParentCycles(elements) {
  const parentById = new Map;
  for (const element of elements) {
    if (typeof element.id === "string" && typeof element.parentId === "string")
      parentById.set(element.id, element.parentId);
  }
  const errors = [];
  const reported = new Set;
  for (const start of parentById.keys()) {
    const path = [];
    const offsetById = new Map;
    let current = start;
    while (current && parentById.has(current)) {
      const offset = offsetById.get(current);
      if (offset !== undefined) {
        const cycle = [...path.slice(offset), current];
        const key = [...new Set(cycle)].sort().join("\x00");
        if (!reported.has(key)) {
          errors.push(`Parent cycle: ${cycle.join(" -> ")}`);
          reported.add(key);
        }
        break;
      }
      offsetById.set(current, path.length);
      path.push(current);
      current = parentById.get(current);
    }
  }
  return errors;
}
function validateEdgeEndpoint(value, side, edgeId, elementIds, errors) {
  if (!isRecord3(value)) {
    errors.push(`Edge ${edgeId} has invalid ${side} endpoint`);
    return;
  }
  if (value.kind === "position") {
    if (typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) {
      errors.push(`Edge ${edgeId} ${side} has non-finite position`);
    }
    if (value.parentId !== undefined && (typeof value.parentId !== "string" || !elementIds.has(value.parentId))) {
      errors.push(`Edge ${edgeId} ${side} references missing parentId: ${String(value.parentId)}`);
    }
    return;
  }
  if (typeof value.elementId !== "string" || !value.elementId) {
    errors.push(`Edge ${edgeId} ${side} has invalid elementId`);
  } else if (!elementIds.has(value.elementId)) {
    errors.push(`Edge ${edgeId} ${side} references missing elementId: ${value.elementId}`);
  }
}
function updateById(records, id, operation, kind) {
  const record = records.find((candidate) => candidate.id === id);
  if (!record)
    throw new Error(`Cannot update missing ${kind}: ${id}`);
  applyPatch(record, operation.patch, operation.unset);
}
function removeById(records, id, kind) {
  const index = records.findIndex((record) => record.id === id);
  if (index < 0)
    throw new Error(`Cannot remove missing ${kind}: ${id}`);
  records.splice(index, 1);
}
function removeElement(bench, id, cascade) {
  const elements = bench.elements;
  const edges = bench.edges;
  if (!elements.some((element) => element.id === id))
    throw new Error(`Cannot remove missing element: ${id}`);
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const element of elements) {
      if (typeof element.id === "string" && typeof element.parentId === "string" && removed.has(element.parentId) && !removed.has(element.id)) {
        removed.add(element.id);
        changed = true;
      }
    }
  }
  const referencingEdges = edges.filter((edge) => endpointReferencesAny(edge.from, removed) || endpointReferencesAny(edge.to, removed));
  if (!cascade && (removed.size > 1 || referencingEdges.length > 0)) {
    const childCount = removed.size - 1;
    throw new Error(`Cannot remove element ${id}: referenced by ${childCount} descendant(s) and ${referencingEdges.length} edge(s); use cascade explicitly`);
  }
  bench.elements = elements.filter((element) => typeof element.id !== "string" || !removed.has(element.id));
  bench.edges = edges.filter((edge) => !endpointReferencesAny(edge.from, removed) && !endpointReferencesAny(edge.to, removed));
}
function endpointReferencesAny(value, ids) {
  return isRecord3(value) && (typeof value.elementId === "string" && ids.has(value.elementId) || typeof value.parentId === "string" && ids.has(value.parentId));
}
function applyPatch(record, patch, unset) {
  if (patch)
    Object.assign(record, structuredClone(patch));
  for (const key of unset ?? [])
    delete record[key];
}
function summarizeOperation(operation) {
  switch (operation.op) {
    case "add-element":
      return `add-element ${recordId(operation.element, "<missing-id>")}`;
    case "add-edge":
      return `add-edge ${recordId(operation.edge, "<missing-id>")}`;
    case "update-document":
      return "update-document";
    default:
      return `${operation.op} ${operation.id}`;
  }
}
function recordId(record, fallback) {
  return typeof record.id === "string" && record.id ? record.id : fallback;
}
function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
function unique(values) {
  return [...new Set(values)];
}
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// scripts/bench-edit.ts
var usage = `kc bench \u2014 structured, validated bench-file editing

Usage:
  kc bench inspect <bench> [--id <id>] [--json]
  kc bench validate <bench> [--root <vault-root>] [--no-check-paths] [--json]
  kc bench create <bench> --document <json-file|-> [--root <vault-root>] [--no-check-paths] [--json]
  kc bench apply <bench> --operations <file|-> [--expected-sha256 <hash>] [--root <vault-root>] [--dry-run] [--no-check-paths] [--json]

Operation file:
  Operation files may be JSON or HJSON.
  Use ''' like a Markdown \`\`\` fence for multiline strings:
    value: '''
    # Heading

    - Item one
    - Item two
    '''

  { "operations": [
    { "op": "add-element", "element": { ... } },
    { "op": "update-element", "id": "text:intro", "patch": { ... }, "unset": ["parentId"] },
    { "op": "remove-element", "id": "group:old", "cascade": true },
    { "op": "add-edge", "edge": { ... } },
    { "op": "update-edge", "id": "edge:one", "patch": { ... } },
    { "op": "remove-edge", "id": "edge:old" },
    { "op": "update-document", "patch": { ... }, "unset": ["obsolete"] }
  ] }

Writes require --expected-sha256. Run inspect first or use --dry-run to obtain the current hash.`;
await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.command || parsed.flags.has("help") || parsed.command === "help") {
    console.log(usage);
    return;
  }
  if (!parsed.file)
    throw new Error(`Missing bench path.

${usage}`);
  const file = resolve(parsed.file);
  if (!isBenchDocumentPath(file))
    throw new Error(`Bench path must end in .bench.hjson or .bench.json: ${parsed.file}`);
  switch (parsed.command) {
    case "inspect":
      await inspectCommand(file, parsed);
      return;
    case "validate":
      await validateCommand(file, parsed);
      return;
    case "create":
      await createCommand(file, parsed);
      return;
    case "apply":
      await applyCommand(file, parsed);
      return;
    default:
      throw new Error(`Unknown command: ${parsed.command}

${usage}`);
  }
}
async function inspectCommand(file, parsed) {
  const content = await readFile(file, "utf8");
  const document = parseBenchDocument(content, file);
  const errors = [...validateBenchDocument(document), ...await linkedPathErrors(document, file, false)];
  const id = flagString(parsed, "id");
  let result;
  if (id) {
    const element = records(document.elements).find((candidate) => candidate.id === id);
    const edge = records(document.edges).find((candidate) => candidate.id === id);
    if (element && edge)
      throw new Error(`Ambiguous id exists as both element and edge: ${id}`);
    if (!element && !edge)
      throw new Error(`No element or edge found with id: ${id}`);
    result = { kind: element ? "element" : "edge", path: file, sha256: sha2562(content), valid: errors.length === 0, value: element ?? edge };
  } else {
    result = {
      document,
      edgeCount: records(document.edges).length,
      elementCount: records(document.elements).length,
      errors,
      path: file,
      sha256: sha2562(content),
      valid: errors.length === 0
    };
  }
  printResult(result, parsed);
}
async function validateCommand(file, parsed) {
  const content = await readFile(file, "utf8");
  const document = parseBenchDocument(content, file);
  const root = resolveRoot(file, parsed);
  const errors = [
    ...validateBenchDocument(document),
    ...await linkedPathErrors(document, root, !parsed.flags.has("no-check-paths"))
  ];
  const result = {
    edgeCount: records(document.edges).length,
    elementCount: records(document.elements).length,
    errors,
    path: file,
    sha256: sha2562(content),
    valid: errors.length === 0
  };
  printResult(result, parsed);
  if (errors.length)
    process.exitCode = 1;
}
async function createCommand(file, parsed) {
  const documentPath = flagString(parsed, "document");
  if (!documentPath)
    throw new Error("create requires --document <json-file|->");
  const text = documentPath === "-" ? await Bun.stdin.text() : await readFile(resolve(documentPath), "utf8");
  const document = JSON.parse(text);
  if (!isRecord4(document))
    throw new Error("Create document must be a JSON object");
  const root = resolveRoot(file, parsed);
  const errors = [
    ...validateBenchDocument(document),
    ...await linkedPathErrors(document, root, !parsed.flags.has("no-check-paths"))
  ];
  if (errors.length)
    throw new Error(`Cannot create invalid bench:
- ${errors.join(`
- `)}`);
  const content = stringifyBenchDocument(document, file);
  try {
    await atomicCreate(file, content);
  } catch (error) {
    if (isRecord4(error) && error.code === "EEXIST")
      throw new Error(`Bench already exists: ${file}`);
    throw error;
  }
  printResult({
    created: true,
    edgeCount: records(document.edges).length,
    elementCount: records(document.elements).length,
    path: file,
    sha256: sha2562(content)
  }, parsed);
}
async function applyCommand(file, parsed) {
  const operationsPath = flagString(parsed, "operations");
  if (!operationsPath)
    throw new Error("apply requires --operations <file|->");
  const dryRun = parsed.flags.has("dry-run");
  const expectedSha256 = flagString(parsed, "expected-sha256");
  if (!dryRun && !expectedSha256)
    throw new Error("--expected-sha256 is required for writes; run inspect first or use --dry-run");
  const sourceInfo = await lstat(file);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new Error(`Refusing to edit non-regular or symbolic-link bench path: ${file}`);
  const content = await readFile(file, "utf8");
  const operations = await readOperations(operationsPath);
  const result = editBenchText({ content, expectedSha256, operations, path: file });
  const pathErrors = await linkedPathErrors(result.document, resolveRoot(file, parsed), !parsed.flags.has("no-check-paths"));
  if (pathErrors.length)
    throw new Error(`Bench edit produced unresolved linked paths:
- ${pathErrors.join(`
- `)}`);
  const diff = result.changed ? await unifiedDiff(file, content, result.content) : "";
  let written = false;
  if (!dryRun && result.changed) {
    await atomicWrite(file, result.content, sourceInfo.mode, result.beforeSha256);
    written = true;
  }
  printResult({
    afterSha256: result.afterSha256,
    beforeSha256: result.beforeSha256,
    changed: result.changed,
    diff,
    path: file,
    summary: result.summary,
    written
  }, parsed);
}
function parseArguments(args) {
  const flags = new Map;
  const positional = [];
  for (let index = 0;index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(rawName, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--") && !["json", "dry-run", "help", "no-check-paths"].includes(rawName)) {
      flags.set(rawName, next);
      index += 1;
    } else {
      flags.set(rawName, true);
    }
  }
  return { command: positional[0], file: positional[1], flags };
}
async function readOperations(path) {
  const text = path === "-" ? await Bun.stdin.text() : await readFile(resolve(path), "utf8");
  const parsed = parseHjsonValue(text);
  const operations = Array.isArray(parsed) ? parsed : isRecord4(parsed) ? parsed.operations : undefined;
  if (!Array.isArray(operations))
    throw new Error("Operations input must be an array or an object containing an operations array");
  return parseBenchEditOperations(operations);
}
async function linkedPathErrors(document, root, checkExistence) {
  const errors = [];
  let canonicalRoot = root;
  if (checkExistence) {
    try {
      canonicalRoot = await realpath(root);
    } catch {
      return [`Vault root does not exist: ${root}`];
    }
  }
  for (const element of records(document.elements)) {
    if (element.type !== "bench" && element.type !== "text-file")
      continue;
    if (typeof element.path !== "string" || !element.path.trim()) {
      errors.push(`Element ${String(element.id)} has missing or invalid path`);
      continue;
    }
    const normalizedPath = element.path.replaceAll("\\", "/");
    if (isAbsolute(normalizedPath) || /^[A-Za-z]:\//.test(normalizedPath)) {
      errors.push(`Element ${String(element.id)} exposes absolute path: ${element.path}`);
      continue;
    }
    if (normalizedPath.split("/").includes("..")) {
      errors.push(`Element ${String(element.id)} escapes vault root: ${element.path}`);
      continue;
    }
    if (!checkExistence)
      continue;
    const linkedPath = resolve(canonicalRoot, normalizedPath);
    const relativePath = relative(canonicalRoot, linkedPath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      errors.push(`Element ${String(element.id)} escapes vault root: ${element.path}`);
      continue;
    }
    try {
      const canonicalLinkedPath = await realpath(linkedPath);
      const canonicalRelativePath = relative(canonicalRoot, canonicalLinkedPath);
      if (canonicalRelativePath === ".." || canonicalRelativePath.startsWith(`..${sep}`)) {
        errors.push(`Element ${String(element.id)} escapes vault root through a symbolic link: ${element.path}`);
        continue;
      }
      const linkedInfo = await stat(canonicalLinkedPath);
      if (!linkedInfo.isFile())
        errors.push(`Element ${String(element.id)} path is not a file: ${element.path}`);
    } catch {
      errors.push(`Element ${String(element.id)} references missing path: ${element.path}`);
    }
  }
  return errors;
}
function resolveRoot(file, parsed) {
  const configuredRoot = flagString(parsed, "root");
  if (configuredRoot)
    return resolve(configuredRoot);
  const result = Bun.spawnSync(["git", "-C", dirname2(file), "rev-parse", "--show-toplevel"], { stderr: "ignore", stdout: "pipe" });
  return result.exitCode === 0 ? resolve(result.stdout.toString().trim()) : dirname2(file);
}
async function atomicCreate(path, content) {
  const temporaryPath = join2(dirname2(path), `.${basename2(path)}.bench-create-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { flag: "wx" });
    await link(temporaryPath, path);
  } finally {
    await rm2(temporaryPath, { force: true });
  }
}
async function atomicWrite(path, content, mode, expectedSha256) {
  const temporaryPath = join2(dirname2(path), `.${basename2(path)}.bench-edit-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode });
    await withFileWriteLock(path, async () => {
      const currentInfo = await lstat(path);
      if (!currentInfo.isFile() || currentInfo.isSymbolicLink())
        throw new Error(`Bench changed to a non-regular or symbolic-link path before atomic replacement: ${path}`);
      const currentSha256 = sha2562(await readFile(path, "utf8"));
      if (currentSha256 !== expectedSha256) {
        throw new Error(`Bench changed before atomic replacement: expected ${expectedSha256}, found ${currentSha256}`);
      }
      await rename(temporaryPath, path);
    });
  } finally {
    await rm2(temporaryPath, { force: true });
  }
}
async function unifiedDiff(path, before, after) {
  const directory = await mkdtemp(join2(tmpdir(), "bench-edit-diff-"));
  const beforePath = join2(directory, "before");
  const afterPath = join2(directory, "after");
  try {
    await writeFile(beforePath, before);
    await writeFile(afterPath, after);
    const process2 = Bun.spawnSync(["diff", "-u", "--label", path, "--label", path, beforePath, afterPath], { stdout: "pipe", stderr: "pipe" });
    if (process2.exitCode !== 0 && process2.exitCode !== 1)
      throw new Error(`diff failed: ${process2.stderr.toString().trim()}`);
    return process2.stdout.toString();
  } finally {
    await rm2(directory, { recursive: true, force: true });
  }
}
function records(value) {
  return Array.isArray(value) ? value.filter(isRecord4) : [];
}
function flagString(parsed, name) {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}
function printResult(result, parsed) {
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if ("valid" in result)
    console.log(result.valid ? "valid" : `invalid
${result.errors.map((error) => `- ${error}`).join(`
`)}`);
  else if (typeof result.diff === "string" && result.diff)
    console.log(`${result.summary.join(`
`)}

${result.diff}`);
  else
    console.log(JSON.stringify(result, null, 2));
}
function sha2562(content) {
  return createHash2("sha256").update(content).digest("hex");
}
function isRecord4(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
