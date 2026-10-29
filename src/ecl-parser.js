"use strict";

/**
 * Experimental, dependency-free SNOMED CT ECL syntax parser for VS Code.
 *
 * parseEcl(text, options?) -> [] (accepted) or
 *   [{ message: string, offset: number, end: number }] (first error).
 * All offsets are UTF-16 character offsets (VS Code TextDocument.positionAt).
 *
 * Supports the core ECL syntax reflected in snomed-ecl.tmLanguage.json:
 * hierarchy operators (symbolic/long), memberOf, wildcard, boolean set
 * operators, refinements, attribute groups/cardinalities, reverse flag,
 * comparison to concepts/numbers/strings/booleans, dot traversal,
 * parenthesized constraints, optional concept terms, and block comments.
 * Also recognizes the 2.2 top/bottom operators and 2.0 refset field selection.
 *
 * Deliberately does NOT accept ECL 1.5+ {{...}} filters/supplements,
 * alternate identifiers, or every advanced typed-search form. These must be
 * implemented before claiming full conformance to ECL v2.2 (or later).
 * This checks syntax, NOT concept existence, edition, semantics, or MRCM.
 *
 * Authoritative formal grammar: https://github.com/IHTSDO/snomed-expression-constraint-language
 */

class EclSyntaxError extends Error {
  constructor(message, offset, end = offset, severity = "error") {
    super(message);
    this.name = "EclSyntaxError";
    this.offset = offset;
    this.end = end;
    this.severity = severity;
  }
}

function tokenize(input, maxTokens = 100000) {
  const tokens = [];
  let i = 0;
  const add = (type, value, start, end) => {
    tokens.push({ type, value, start, end });
    if (tokens.length > maxTokens) throw new EclSyntaxError("ECL contains too many tokens", start, end);
  };
  while (i < input.length) {
    const ch = input[i];
    if (/\s/u.test(ch)) { i++; continue; }
    if (input.startsWith("/*", i)) {
      const end = input.indexOf("*/", i + 2);
      if (end < 0) throw new EclSyntaxError("Unterminated /* ... */ comment", i, input.length);
      i = end + 2;
      continue;
    }
    const start = i;
    if (ch === "|") {
      const end = input.indexOf("|", i + 1);
      if (end < 0) throw new EclSyntaxError("Unterminated concept term: missing '|'", start, input.length);
      const value = input.slice(i + 1, end);
      if (!value.trim() || /[\r\n\x00-\x1f\x7f|]/.test(value)) {
        throw new EclSyntaxError("Invalid or empty concept term", start, end + 1);
      }
      i = end + 1;
      add("term", value, start, i);
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === '"') { i++; closed = true; break; }
        if (input[i] === "\\") {
          if (input[i + 1] !== '"' && input[i + 1] !== "\\") {
            throw new EclSyntaxError("Invalid string escape: use \\\\ or \\\"", i, i + 2);
          }
          i += 2;
        } else {
          if (/[\x00-\x1f\x7f]/.test(input[i])) {
            throw new EclSyntaxError("Invalid control character in string", i, i + 1);
          }
          i++;
        }
      }
      if (!closed) throw new EclSyntaxError("Unterminated quoted string", start, input.length);
      if (i === start + 2) throw new EclSyntaxError("Quoted search string cannot be empty", start, i);
      add("string", input.slice(start, i), start, i);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const match = /^\d+(?:\.[0-9]+)?/.exec(input.slice(i));
      i += match[0].length;
      add("number", match[0], start, i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(input.slice(i));
      i += match[0].length;
      add("word", match[0], start, i);
      continue;
    }
    const symbol = ["<<!", ">>!", "!!>", "!!<", "<<", ">>", "<!", ">!", "<=", ">=", "!=", "<>", "..", "{{", "}}"].find(s => input.startsWith(s, i));
    if (symbol) {
      i += symbol.length;
      add("symbol", symbol, start, i);
      continue;
    }
    if ("(){}[]:.,^*=<>#+-".includes(ch)) {
      i++;
      add("symbol", ch, start, i);
      continue;
    }
    throw new EclSyntaxError(`Unexpected character '${ch}'`, i, i + 1);
  }
  add("eof", "<EOF>", input.length, input.length);
  return tokens;
}

const HIERARCHY = new Set([
  "<<!", ">>!", "<<", ">>", "<!", ">!", "<", ">", "!!<", "!!>",
  "descendantof", "descendantorselfof", "childof", "childorselfof",
  "ancestorof", "ancestororselfof", "parentof", "parentorselfof",
  "top", "bottom"
]);

class EclParser {
  constructor(input, options = {}) {
    this.tokens = tokenize(input, options.maxTokens ?? 100000);
    this.i = 0;
    this.depth = 0;
    this.maxDepth = options.maxDepth ?? 100;
  }

  current() { return this.tokens[this.i]; }
  at(value) { return this.current().value.toLowerCase() === value.toLowerCase(); }
  accept(value) { if (this.at(value)) { this.i++; return true; } return false; }
  expect(value, message = `Expected '${value}'`) {
    if (!this.accept(value)) this.fail(message);
  }
  fail(message, token = this.current()) {
    throw new EclSyntaxError(message, token.start, token.end);
  }
  enter(fn) {
    if (++this.depth > this.maxDepth) this.fail("Expression is nested too deeply");
    try { return fn(); } finally { this.depth--; }
  }

  parse() {
    this.expression();
    if (!this.at("<EOF>")) this.fail(`Unexpected '${this.current().value}' after expression`);
  }

  logical() {
    if (this.at(",") || this.at("and")) return "AND";
    if (this.at("or")) return "OR";
    if (this.at("minus")) return "MINUS";
    return null;
  }

  // At one expression level, AND/OR/MINUS must not mix unparenthesized.
  expression() {
    return this.enter(() => {
      this.subExpression();
      if (this.accept(":")) {
        this.refinement();
        return;
      }
      if (this.accept(".")) {
        this.subExpression();
        while (this.accept(".")) this.subExpression();
        return;
      }
      let operator = null;
      let count = 0;
      while (this.logical()) {
        const next = this.logical();
        if (operator && operator !== next) this.fail("Mixed AND/OR/MINUS operators require parentheses");
        if (next === "MINUS" && count > 0) this.fail("Multiple MINUS operations require parentheses");
        operator = next;
        count++;
        this.i++;
        this.subExpression();
      }
    });
  }

  subExpression() {
    return this.enter(() => {
      const prefix = this.current().value.toLowerCase();
      if (HIERARCHY.has(prefix)) this.i++;

      let member = this.accept("^");
      if (!member && this.accept("memberOf")) member = true;
      if (member && this.accept("[")) {
        if (!this.accept("*")) {
          this.fieldName();
          while (this.accept(",")) this.fieldName();
        }
        this.expect("]", "Expected ']' after reference set field selection");
      }

      if (this.accept("(")) {
        this.expression();
        this.expect(")", "Expected ')' after ECL subexpression");
      } else if (!this.accept("*") && !this.accept("any")) {
        this.concept();
      }

      if (this.at("{{")) {
        const token = this.current();
        throw new EclSyntaxError(
          "Cannot validate {{...}} filters/history supplements: parser support not implemented",
          token.start, token.end, "warning"
        );
      }
    });
  }

  fieldName() {
    const token = this.current();
    if (token.type !== "word" || !/^[A-Za-z]+$/.test(token.value)) {
      this.fail("Expected a reference set field name");
    }
    this.i++;
  }

  concept() {
    const token = this.current();
    if (token.type === "word" && this.tokens[this.i + 1]?.value === "#") {
      throw new EclSyntaxError(
        "Cannot validate alternate identifiers (scheme#value): parser support not implemented",
        token.start, token.end, "warning"
      );
    }
    if (token.type !== "number" || !/^[1-9]\d{5,17}$/.test(token.value)) {
      this.fail("Expected an SCTID (6–18 digits, no leading zero)");
    }
    this.i++;
    if (this.current().type === "term") this.i++;
  }

  cardinality() {
    this.expect("[");
    const min = this.current();
    if (min.type !== "number" || !/^(?:0|[1-9]\d*)$/.test(min.value)) {
      this.fail("Expected nonnegative minimum cardinality");
    }
    this.i++;
    if (!this.accept("..") && !this.accept("to")) this.fail("Expected '..' or 'to' in cardinality");
    if (this.accept("*") || this.accept("many")) {
      this.expect("]", "Expected ']' after cardinality");
      return;
    }
    const max = this.current();
    if (max.type !== "number" || !/^(?:0|[1-9]\d*)$/.test(max.value)) {
      this.fail("Expected nonnegative maximum cardinality or '*'");
    }
    if (BigInt(min.value) > BigInt(max.value)) this.fail("Cardinality minimum exceeds maximum", max);
    this.i++;
    this.expect("]", "Expected ']' after cardinality");
  }

  // Determine whether an optional [x..y] prefix belongs to a {group}.
  groupAhead(start = this.i) {
    let k = start;
    if (this.tokens[k].value === "[") {
      while (k < this.tokens.length && this.tokens[k].value !== "]" && this.tokens[k].type !== "eof") k++;
      if (this.tokens[k].value !== "]") return false;
      k++;
    }
    return this.tokens[k] && this.tokens[k].value === "{";
  }

  refinement() {
    return this.enter(() => {
      this.refinementPart();
      let op = null;
      while (this.logical()) {
        const next = this.logical();
        if (next === "MINUS") this.fail("MINUS is not allowed between refinements");
        if (op && next !== op) this.fail("Mixed AND/OR in refinement require parentheses");
        op = next;
        this.i++;
        this.refinementPart();
      }
    });
  }

  refinementPart() {
    if (this.accept("(")) {
      this.refinement();
      this.expect(")", "Expected ')' after refinement");
    } else if (this.groupAhead()) {
      if (this.at("[")) this.cardinality();
      this.expect("{");
      this.attributeSet();
      this.expect("}", "Expected '}' after attribute group");
    } else {
      this.attributeSet();
    }
  }

  attributeSet() {
    return this.enter(() => {
      this.attributeOrParenSet();
      let op = null;
      while (this.logical()) {
        // Parenthesized refinements and {groups} belong to the outer refinement.
        const nextToken = this.i + 1;
        if (this.groupAhead(nextToken) || this.tokens[nextToken].value === "(") break;
        const next = this.logical();
        if (next === "MINUS") this.fail("MINUS is not allowed between attributes");
        if (op && next !== op) this.fail("Mixed AND/OR between attributes require parentheses");
        op = next;
        this.i++;
        this.attributeOrParenSet();
      }
    });
  }

  attributeOrParenSet() {
    if (this.at("(")) {
      // ECL allows both (attribute AND attribute) and (concept OR concept) = value.
      // Prefer the attribute-name interpretation if it parses successfully.
      const saved = this.i;
      try { this.attribute(); return; }
      catch (error) { if (!(error instanceof EclSyntaxError)) throw error; this.i = saved; }
      this.expect("(");
      this.attributeSet();
      this.expect(")", "Expected ')' after attribute set");
    } else {
      this.attribute();
    }
  }

  attribute() {
    if (this.at("[")) this.cardinality();
    if (this.at("R") || this.at("reverseOf")) this.i++;
    this.subExpression();
    let comparison;
    if (this.accept("not")) {
      this.expect("=", "Expected '=' after NOT");
      comparison = "!=";
    } else if (["=", "!=", "<>", "<", "<=", ">", ">="].includes(this.current().value)) {
      comparison = this.current().value;
      this.i++;
    } else {
      this.fail("Expected comparison operator (=, !=, <, <=, >, >=) after attribute name");
    }

    if (this.accept("#")) {
      if (this.at("+") || this.at("-")) this.i++;
      const num = this.current();
      if (num.type !== "number" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(num.value)) {
        this.fail("Expected numeric value after '#'");
      }
      this.i++;
      return;
    }
    const looksLikeStringSet = this.at("(") && (
      this.tokens[this.i + 1]?.type === "string" ||
      ["match", "wild"].includes(this.tokens[this.i + 1]?.value?.toLowerCase())
    );
    if (this.current().type === "string" || this.at("match") || this.at("wild") || looksLikeStringSet) {
      if (!["=", "!=", "<>"].includes(comparison)) this.fail("String comparisons allow only = or !=");
      this.stringValue();
      return;
    }
    if (this.at("true") || this.at("false")) {
      if (!["=", "!=", "<>"].includes(comparison)) this.fail("Boolean comparisons allow only = or !=");
      this.i++;
      return;
    }
    if (!["=", "!=", "<>"].includes(comparison)) this.fail("Concept comparisons allow only = or !=");
    this.subExpression();
  }

  stringValue() {
    if (this.accept("(")) {
      this.oneSearchTerm();
      let previous = this.tokens[this.i - 1];
      while (!this.at(")") && !this.at("<EOF>")) {
        // A string set uses whitespace, not commas, between terms.
        if (this.current().start === previous.end) this.fail("Expected space between search strings");
        this.oneSearchTerm();
        previous = this.tokens[this.i - 1];
      }
      this.expect(")", "Expected ')' after search string set");
      return;
    }
    this.oneSearchTerm();
  }

  oneSearchTerm() {
    if (this.at("match") || this.at("wild")) {
      this.i++;
      this.expect(":", "Expected ':' after match/wild keyword");
    }
    if (this.current().type !== "string") this.fail("Expected quoted search string");
    this.i++;
  }
}

function parseEcl(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("parseEcl expects a string");
  try {
    const parser = new EclParser(text, options);
    parser.parse();
    return [];
  } catch (error) {
    if (!(error instanceof EclSyntaxError)) throw error;
    return [{ message: error.message, offset: error.offset, end: error.end, severity: error.severity }];
  }
}

module.exports = { parseEcl, EclSyntaxError };
