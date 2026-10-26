
class ScgSyntaxError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = "ScgSyntaxError";
    this.offset = offset;
  }
}

function parseScg(text) {
  let i = 0;

  const fail = message => {
    throw new ScgSyntaxError(message, i);
  };

  const ws = () => {
    while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
  };

  const at = value => {
    ws();
    return text.startsWith(value, i);
  };

  const take = value => {
    if (!at(value)) return false;
    i += value.length;
    return true;
  };

  const expect = (value, message) => {
    if (!take(value)) fail(message || `Expected '${value}'`);
  };

  function concept() {
    ws();
    const id = /^[1-9][0-9]{5,17}/.exec(text.slice(i));

    if (!id) fail("Expected SNOMED CT concept ID (6–18 digits)");
    i += id[0].length;

    if (take("|")) {
      const end = text.indexOf("|", i);
      if (end < 0) fail("Unterminated concept term: expected |");

      const term = text.slice(i, end);
      if (!term.trim() || /[\t\r\n\x00-\x1f\x7f]/.test(term)) {
        fail("Invalid or empty concept term");
      }
      i = end + 1;
    }
  }

  function value() {
    if (take("(")) {
      subExpression();
      expect(")", "Expected closing )");
    } else if (take('"')) {
      let count = 0;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++;
          if (text[i] !== '"' && text[i] !== "\\") {
            fail("Invalid string escape");
          }
        }
        i++;
        count++;
      }
      if (!count) fail("Concrete string cannot be empty");
      expect('"', "Unterminated concrete string");
    } else if (take("#")) {
      const number =
        /^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/.exec(
          text.slice(i)
        );
      if (!number) fail("Expected concrete number after #");
      i += number[0].length;
    } else {
      ws();
      const bool = /^(?:true|false)/i.exec(text.slice(i));
      if (bool) i += bool[0].length;
      else if (i === text.length) {
        fail("Expected attribute value after =");
      } else {
        concept();
      }
    }
  }

  function attribute() {
    concept();
    expect("=", "Expected = after attribute name");
    value();
  }

  function attributeSet() {
    attribute();
    while (at(",") && !/^,[ \t\r\n]*\{/.test(text.slice(i))) {
      i++;
      attribute();
    }
  }

  function group() {
    expect("{");
    attributeSet();
    expect("}", "Expected closing }");
  }

  function refinement() {
    if (at("{")) group();
    else attributeSet();

    while (true) {
      const comma = take(",");
      if (at("{")) group();
      else if (comma) fail("Expected attribute group after comma");
      else break;
    }
  }

  function subExpression() {
    concept();
    while (take("+")) concept();
    if (take(":")) refinement();
  }

  try {
    if (!take("===") && !take("<<<")) ws();
    subExpression();
    ws();

    if (i !== text.length) {
      fail(`Unexpected token '${text[i]}'`);
    }

    return [];
  } catch (error) {
    if (!(error instanceof ScgSyntaxError)) throw error;
    return [{ message: error.message, offset: error.offset }];
  }
}

module.exports = { parseScg };
