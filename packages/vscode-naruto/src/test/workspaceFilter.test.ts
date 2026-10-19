import * as assert from "assert";
import { fileNameMatcher } from "../workspaceFilter";

suite("Naruto filename filter", () => {
  const defaults = { query: "", matchCase: false, wholeWord: false, regex: false };

  test("literal matching escapes regular expression characters and supports case sensitivity", () => {
    const insensitive = fileNameMatcher({ ...defaults, query: "Readme.ts" });
    assert.ok(insensitive("README.ts"));
    assert.ok(!insensitive("ReadmeXts"));
    const sensitive = fileNameMatcher({ ...defaults, query: "Readme", matchCase: true });
    assert.ok(sensitive("Readme.md"));
    assert.ok(!sensitive("README.md"));
  });

  test("whole words respect punctuation, underscores, and Unicode letters", () => {
    const match = fileNameMatcher({ ...defaults, query: "foo", wholeWord: true });
    assert.ok(match("foo.ts"));
    assert.ok(match("test-foo.ts"));
    assert.ok(!match("foobar.ts"));
    assert.ok(!match("foo_bar.ts"));
    const chinese = fileNameMatcher({ ...defaults, query: "你好", wholeWord: true });
    assert.ok(chinese("你好.ts"));
    assert.ok(!chinese("你好啊.ts"));
  });

  test("regular expressions combine with the other switches and reject invalid expressions", () => {
    const match = fileNameMatcher({ ...defaults, query: "^(foo|bar)\\.ts$", regex: true, matchCase: true });
    assert.ok(match("foo.ts"));
    assert.ok(match("bar.ts"));
    assert.ok(!match("FOO.ts"));
    assert.ok(!match("foobar.ts"));
    const whole = fileNameMatcher({ ...defaults, query: "foo|bar", regex: true, wholeWord: true });
    assert.ok(whole("bar.ts"));
    assert.ok(!whole("foobar.ts"));
    assert.throws(() => fileNameMatcher({ ...defaults, query: "[", regex: true }));
    assert.ok(fileNameMatcher(defaults)("anything"));
  });
});
