"use strict";

/**
 * Experimental, dependency-free SNOMED CT Expression Template Language parser.
 *
 * Intended for editor syntax diagnostics, not normative conformance certification.
 * Based on the structure of ETL v1.1.1 (SCG v2.4 + Template Syntax v1.1.1
 * + ECL v1.4). ECL handling is deliberately a useful subset, not a complete
 * implementation of the normative ECL grammar.
 *
 * The public API matches the companion SCG example:
 *   parseEtl(text) -> [] | [{ message: string, offset: number, end: number }]
 *
 * Offsets are UTF-16 offsets, compatible with VS Code's document.positionAt().
 * No terminology-service, SCTID existence, or MRCM checks are performed.
 *
 * Reference: https://docs.snomed.org/snomed-ct-specifications/
 *   snomed-ct-template-syntax-specification/6-snomed-ct-language-templates/
 *   6.1-expression-template-language
 */

class EtlSyntaxError extends Error {
  constructor(message, offset, end = offset) {
    super(message);
    this.name = "EtlSyntaxError";
    this.offset = offset;
    this.end = end;
  }
}

class Parser {
  constructor(source, options = {}) {
    this.s = source;
    this.i = 0;
    this.depth = 0;
    this.maxDepth = options.maxDepth ?? 120;
  }

  error(message, offset = this.i) {
    throw new EtlSyntaxError(message, offset);
  }

  ws() {
    while (this.i < this.s.length && /[ \t\r\n]/.test(this.s[this.i])) this.i++;
  }

  at(value) {
    this.ws();
    return this.s.startsWith(value, this.i);
  }

  take(value) {
    if (!this.at(value)) return false;
    this.i += value.length;
    return true;
  }

  expect(value, message) {
    if (!this.take(value)) this.error(message || `Expected '${value}'`);
  }

  regex(re, message) {
    this.ws();
    const match = re.exec(this.s.slice(this.i));
    if (!match) this.error(message);
    this.i += match[0].length;
    return match[0];
  }

  keyword(word) {
    this.ws();
    const piece = this.s.slice(this.i, this.i + word.length);
    if (piece.toLowerCase() !== word.toLowerCase()) return false;
    // Keywords should not eat the beginning of an identifier or name.
    if (/[A-Za-z0-9_]/.test(this.s[this.i + word.length] || "")) return false;
    this.i += word.length;
    return true;
  }

  bounded(action) {
    if (++this.depth > this.maxDepth) this.error("Expression is nested too deeply");
    try { return action(); } finally { this.depth--; }
  }

  parse() {
    this.ws();
    if (this.at("[[") && this.looksLikeReplacement()) {
      // Only token replacement slots can replace the definition status.
      const save = this.i;
      this.expect("[[");
      this.expect("+");
      const kind = this.keyword("tok") ? "tok" : "other";
      this.i = save;
      if (kind === "tok") this.replacementSlot("token");
    } else if (!this.take("===") && !this.take("<<<")) {
      // Definition status is optional.
    }
    this.subExpression();
    this.ws();
    if (this.i < this.s.length) this.error(`Unexpected text '${this.s.slice(this.i, this.i + 18)}'`);
  }

  looksLikeReplacement() {
    if (!this.at("[[")) return false;
    return /^\[\[[ \t\r\n]*\+/.test(this.s.slice(this.i));
  }

  isInfoSlot() {
    return this.at("[[") && !this.looksLikeReplacement();
  }

  informationSlot() {
    if (!this.isInfoSlot()) return false;
    this.expect("[[");
    this.ws();
    if (/^[0-9]/.test(this.s.slice(this.i))) this.cardinality();
    if (this.at("@")) this.slotName();
    this.expect("]]", "Expected ']]' to close information slot");
    return true;
  }

  cardinality() {
    this.regex(/^(?:0|[1-9][0-9]*)\.\.(?:0|[1-9][0-9]*|\*)/, "Expected cardinality such as 0..1 or 1..*");
  }

  slotName() {
    this.expect("@");
    // No whitespace is allowed between @ and the slot name.
    if (this.s[this.i] === '"') return this.quotedString();
    // nonQuoteStringValue (ABNF character ranges) excludes whitespace,
    // double quotes, @, brackets, parentheses, and apostrophes.
    const match = /^[\x21\x23-\x26\x2A-\x3F\x41-\x5A\x5C\x5E-\x7E]+/.exec(this.s.slice(this.i));
    if (!match) this.error("Expected slot name after @");
    this.i += match[0].length;
  }

  replacementSlot(position) {
    this.expect("[[");
    this.expect("+", "Expected '+' in replacement slot");
    this.ws();

    let type;
    if (this.keyword("id")) type = "id";
    else if (this.keyword("scg")) type = "scg";
    else if (this.keyword("tok")) type = "tok";
    else if (this.keyword("str")) type = "str";
    else if (this.keyword("int")) type = "int";
    else if (this.keyword("dec")) type = "dec";
    else if (this.keyword("bool")) type = "bool";
    else if (this.at("(") || this.at("@") || this.at("]]")) type = "scg";
    else this.error("Expected replacement type: id, scg, tok, str, int, dec or bool");

    const allowed = {
      concept: ["id", "scg"],
      concrete: ["str", "int", "dec", "bool"],
      value: ["id", "scg", "str", "int", "dec", "bool"],
      token: ["tok"],
    };
    if (!allowed[position].includes(type)) {
      this.error(`A ${type} slot cannot be used as a ${position} value`);
    }

    if (this.take("(")) {
      if (type === "id" || type === "scg") this.eclConstraint();
      else if (type === "tok") this.tokenSet();
      else this.valueSet(type);
      this.expect(")", `Expected ')' to close ${type} slot constraint`);
    }

    if (this.at("@")) this.slotName();
    this.expect("]]", "Expected ']]' to close replacement slot");
  }

  tokenSet() {
    const tokens = /^(?:===|<<<|<<|<!|>>|>!|<=|>=|!=|<|>|\^|=|,|\b(?:AND|OR|MINUS|R)\b)/i;
    const next = () => this.regex(tokens, "Expected ECL token in tok set");
    next();
    while (true) {
      const before = this.i;
      this.ws();
      if (this.i === before || this.s[this.i] === ")") break;
      next();
    }
  }

  valueSet(type) {
    this.oneSetItem(type);
    while (true) {
      const before = this.i;
      this.ws();
      if (this.i === before || this.s[this.i] === ")") break;
      this.oneSetItem(type);
    }
  }

  oneSetItem(type) {
    if (type === "str") return this.quotedString();
    if (type === "bool") return this.boolean();
    // Integer/decimal sets allow individual values and open/closed ranges:
    // #1  #1..#10  >#1..<#10  ..#10  #1..
    if (this.take("..")) {
      this.take("<");
      this.concreteNumber(type);
      return;
    }
    const exclusiveMin = this.take(">");
    this.concreteNumber(type);
    // Do not skip whitespace before '..' (ABNF uses adjacent 'to').
    if (this.s.startsWith("..", this.i)) {
      this.i += 2;
      const exclusiveMax = this.s[this.i] === "<";
      if (exclusiveMax) this.i++;
      if (this.s[this.i] === "#") this.concreteNumber(type);
      else if (exclusiveMax) this.error("Expected upper bound after '<'");
    } else if (exclusiveMin) {
      this.error("Exclusive minimum ('>') requires a range '..'");
    }
  }

  concreteNumber(type = "either") {
    this.expect("#", "Expected '#' before concrete number");
    // Digits must be adjacent to the '#' sign.
    const start = this.i;
    const number = /^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/.exec(this.s.slice(this.i));
    if (!number) this.error("Expected a numeric value after '#'");
    this.i += number[0].length;
    const decimal = number[0].includes(".");
    if (type === "int" && decimal) this.error("Integer slot cannot contain a decimal", start);
    if (type === "dec" && !decimal) this.error("Decimal slot requires a fractional part", start);
  }

  boolean() {
    this.regex(/^(?:true|false)(?![A-Za-z0-9_])/i, "Expected boolean true or false");
  }

  quotedString() {
    this.expect('"', 'Expected opening double quote');
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i++];
      if (ch === '"') {
        if (this.i === start + 1) this.error("String cannot be empty", start);
        return;
      }
      if (ch === "\\") {
        const next = this.s[this.i++];
        if (next !== "\\" && next !== '"') this.error("Invalid string escape; only escaped quotes or backslashes are supported", this.i - 2);
      } else if (ch.charCodeAt(0) < 32 && !"\t\r\n".includes(ch)) {
        this.error("Invalid control character in string", this.i - 1);
      }
    }
    this.error('Unterminated string; expected closing "', start);
  }

  concept() {
    this.ws();
    const start = this.i;
    const match = /^[1-9][0-9]{5,17}/.exec(this.s.slice(this.i));
    if (!match) this.error("Expected a SNOMED CT concept ID (6–18 digits)");
    this.i += match[0].length;
    if (/[0-9]/.test(this.s[this.i] || "")) this.error("SCTID exceeds 18 digits", start);
    if (this.take("|")) {
      const opening = this.i;
      const closing = this.s.indexOf("|", this.i);
      if (closing === -1) this.error("Expected closing '|' in term", opening);
      const term = this.s.slice(this.i, closing);
      if (!term.trim() || /[\t\r\n\x00-\x1f\x7f]/.test(term)) {
        this.error("Invalid or empty SNOMED CT term", opening);
      }
      this.i = closing + 1;
    }
  }

  conceptReference() {
    if (this.looksLikeReplacement()) this.replacementSlot("concept");
    else this.concept();
  }

  subExpression() {
    return this.bounded(() => {
      this.informationSlot();
      this.conceptReference();
      while (this.take("+")) {
        this.informationSlot();
        this.conceptReference();
      }
      if (this.take(":")) this.refinement();
    });
  }

  isGroupAhead() {
    const saved = this.i;
    try {
      this.informationSlot();
      return this.at("{");
    } finally {
      this.i = saved;
    }
  }

  attribute() {
    this.informationSlot();
    this.conceptReference();
    this.expect("=", "Expected '=' after attribute name");
    this.attributeValue();
  }

  attributeValue() {
    if (this.looksLikeReplacement()) return this.replacementSlot("value");
    if (this.take("(")) {
      this.subExpression();
      return this.expect(")", "Expected ')' after nested expression");
    }
    if (this.at('"')) return this.quotedString();
    if (this.at("#")) return this.concreteNumber();
    this.ws();
    if (/^(?:true|false)(?![A-Za-z0-9_])/i.test(this.s.slice(this.i))) {
      return this.boolean();
    }
    if (this.i === this.s.length || this.at(",") || this.at("}")) {
      this.error("Expected an attribute value after '='");
    }
    this.conceptReference();
  }

  attributeSet() {
    this.attribute();
    while (this.at(",")) {
      const saved = this.i;
      this.expect(",");
      if (this.isGroupAhead()) {
        this.i = saved;
        break;
      }
      this.attribute();
    }
  }

  group() {
    this.informationSlot();
    this.expect("{", "Expected '{' to start attribute group");
    this.attributeSet();
    this.expect("}", "Expected '}' to close attribute group");
  }

  refinement() {
    if (this.isGroupAhead()) this.group();
    else this.attributeSet();
    while (true) {
      const hadComma = this.take(",");
      if (this.isGroupAhead()) this.group();
      else if (hadComma) this.error("Expected an attribute group after ','");
      else break;
    }
  }

  // ECL v1.4 subset used only inside ( ... ) replacement-slot constraints.
  // Parses concept constraints, operators, unions, dots, refinements and most
  // common attribute comparisons. A production parser should use the official
  // grammar instead of claiming complete ECL conformance.
  eclConstraint() {
    return this.bounded(() => {
      this.eclSub();
      if (this.take(":")) this.eclRefinement();
      else if (this.take(".")) {
        this.eclSub();
        while (this.take(".")) this.eclSub();
      } else {
        while (this.eclOperator()) this.eclSub();
      }
    });
  }

  eclOperator() {
    if (this.take(",")) return true;
    // ECL keywords require whitespace after them.
    this.ws();
    const match = /^(AND|OR|MINUS)(?=[ \t\r\n])/i.exec(this.s.slice(this.i));
    if (!match) return false;
    this.i += match[0].length;
    this.ws();
    return true;
  }

  eclSub() {
    return this.bounded(() => {
      this.ws();
      for (const op of ["<<", "<!", ">>", ">!", "<", ">"] ) {
        if (this.take(op)) break;
      }
      this.take("^");
      if (this.take("(")) {
        this.eclConstraint();
        this.expect(")", "Expected ')' to close ECL expression");
      } else if (!this.take("*")) {
        this.concept();
      }
    });
  }

  eclRefinement() {
    return this.bounded(() => {
      this.eclRefinementPart();
      while (this.eclOperator()) this.eclRefinementPart();
    });
  }

  eclRefinementPart() {
    if (this.take("(")) {
      this.eclRefinement();
      return this.expect(")", "Expected ')' to close ECL refinement");
    }
    if (this.at("[") || this.at("{")) {
      const hadCardinality = this.take("[");
      if (hadCardinality) {
        this.cardinality();
        this.expect("]", "Expected ']' after ECL cardinality");
      }
      if (this.take("{")) {
        this.eclAttributeSet();
        return this.expect("}", "Expected '}' after ECL attribute group");
      }
      if (hadCardinality) return this.eclAttribute();
    }
    this.eclAttribute();
  }

  eclAttributeSet() {
    this.eclAttribute();
    while (this.eclOperator()) this.eclAttribute();
  }

  eclAttribute() {
    if (this.take("[")) {
      this.cardinality();
      this.expect("]", "Expected ']' after ECL attribute cardinality");
    }
    this.ws();
    if (/^R(?=[ \t\r\n])/i.test(this.s.slice(this.i))) {
      this.i++;
      this.ws();
    }
    this.eclSub();
    this.ws();
    let op = null;
    for (const test of ["!=", "<=", ">=", "=", "<", ">"] ) {
      if (this.take(test)) { op = test; break; }
    }
    if (!op) this.error("Expected comparison operator after ECL attribute name");
    if (this.at("#")) return this.concreteNumber();
    if (this.at('"')) {
      if (op !== "=" && op !== "!=") this.error("String comparisons use = or !=");
      return this.quotedString();
    }
    if (/^(?:true|false)(?![A-Za-z0-9_])/i.test(this.s.slice(this.i))) {
      if (op !== "=" && op !== "!=") this.error("Boolean comparisons use = or !=");
      return this.boolean();
    }
    if (!["=", "!="].includes(op)) this.error("Concept comparisons use = or !=");
    this.eclSub();
  }
}

function parseEtl(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("parseEtl expects a string");
  const parser = new Parser(text, options);
  try {
    parser.parse();
    return [];
  } catch (error) {
    if (!(error instanceof EtlSyntaxError)) throw error;
    return [{ message: error.message, offset: error.offset, end: error.end }];
  }
}

module.exports = { parseEtl, EtlSyntaxError };
