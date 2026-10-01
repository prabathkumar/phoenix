/**
 * Grounded snapshot layer (docs/PHOENIX_SPEC.md §6, Phase 2 — "AI-native
 * semantic layer"). First building block of the unattended/semantic
 * track: everything else Phase 2 needs (`act("tap the Login button")`,
 * and eventually Phase 3's autonomous loop) depends on turning a raw
 * accessibility tree into something an LLM can read and reference
 * directly, which is what this module does. The mobile equivalent of
 * the grounded ARIA-snapshot approach already common for web agents.
 *
 * This is intentionally separate from pipeline.js's rule-based
 * extraction (extractLabels/resolveElementAtCoordinate): those stay
 * exactly as they are, driving the guided-recording path (Act 1 — see
 * README's "AI" section) untouched. This module is additive
 * groundwork for Act 2 (unattended AI) and isn't wired into the live
 * recording session or run-session.js yet — it operates on a captured
 * pageSourceXml string, same input pipeline.js's extractLabels() takes,
 * so it can be exercised against any already-captured accessibility
 * tree (live or from a fixture) without touching the guided pipeline.
 *
 * Design: assign every interactive/labeled element a short, stable
 * (for one snapshot) integer ref, and render a compact indented text
 * block an LLM can read in a handful of lines instead of raw XML that
 * can run to tens of thousands of characters. semantic-act.js is what
 * actually asks an LLM to pick a ref from this text; this module only
 * builds and renders the snapshot itself.
 */

const { DOMParser } = require("@xmldom/xmldom");

// Same invisible-character rule generation/pipeline.js's isBlank()/
// cleanLabel() apply -- a rolled-up-empty label (e.g. a zero-width
// space) must not appear as a "real" element in the snapshot either.
const INVISIBLE_CHARS_RE = /[​‌‍﻿]/g;
function isBlank(value) {
  if (!value) return true;
  return value.replace(INVISIBLE_CHARS_RE, "").trim().length === 0;
}
function clean(value) {
  return value ? value.replace(INVISIBLE_CHARS_RE, "").trim() : undefined;
}

/**
 * @typedef {Object} SnapshotElement
 * @property {number} ref - stable within this one snapshot only; a
 *   fresh call to buildGroundedSnapshot() may assign different refs
 *   even for the "same" element if the tree shape changed at all, so
 *   callers must resolve a ref against the snapshot it came from, not
 *   cache it across snapshots.
 * @property {string} role - the element's tag name (e.g. "Button",
 *   "android.widget.EditText", "XCUIElementTypeButton") -- kept as the
 *   raw platform tag rather than normalized, so the text an LLM reads
 *   still carries real platform detail (a model can tell a Button from
 *   a Switch from a tag name even without further normalization).
 * @property {string} [label] - visible text/label/value/content-desc,
 *   whichever the tree populated -- see pipeline.js's extractLabels()
 *   for why this same attribute set covers both Android and iOS trees.
 * @property {string} [resourceId] - Android only.
 * @property {string} [accessibilityId] - content-desc (Android) or name
 *   (iOS) -- the WebDriver "accessibility id" strategy's value.
 * @property {number} depth - nesting depth from the tree root, purely
 *   for indentation when rendering; not semantically meaningful.
 * @property {{x:number,y:number,width:number,height:number}} [bounds] -
 *   on-screen position, when the tree carried one (Android's single
 *   `bounds` string, or iOS's x/y/width/height attributes — same two
 *   shapes pipeline.js's extractLabels() reads). Not used by the
 *   text-only snapshot rendering, but is what a fused (screenshot +
 *   snapshot) resolution needs to relate a ref to a region of the
 *   image — see buildFusedSnapshot() below and
 *   docs/PHOENIX_SPEC.md §6's "merge accessibility tree + screenshot"
 *   bullet.
 * @property {string} [nearbyLabel] - set on a blank editable input (see
 *   INPUT_ROLE_RE) that has none of label/resourceId/accessibilityId of
 *   its own, OR on an input whose resourceId is ambiguous (see
 *   ambiguousResourceId below): the most recent labeled text seen before
 *   it in document order, as a best-effort hint of which field this is
 *   (e.g. "Yes Number"). Found necessary from a real device run where a
 *   Compose UI left every input field itself unlabeled.
 * @property {string} [xpath] - set under the same two conditions as
 *   nearbyLabel -- a structural locator, used as a fallback when there's
 *   no reliable id/label to select on.
 * @property {boolean} [ambiguousResourceId] - true when this input-role
 *   element's resourceId is shared by more than one element in this same
 *   snapshot (and it has no label/accessibilityId of its own to
 *   disambiguate). Found for real: a login screen's Yes Number and
 *   Password fields were both plain EditTexts with the identical
 *   resource-id, so a resource-id selector built from either one matched
 *   whichever WebDriver happened to find first. semantic-act.js's
 *   toSelector() checks this flag to prefer the xpath fallback over the
 *   ambiguous resource-id.
 * @property {boolean} [clickable] - Android only, from the tree's own
 *   `clickable` attribute; undefined on iOS (no such attribute) or when
 *   Android simply didn't set it. false means tapping this exact element
 *   is a known no-op.
 * @property {string} [clickableAncestorXPath] - set when clickable is
 *   explicitly false and some ancestor in the tree IS clickable: an
 *   xpath to that ancestor, for redirecting a tap there instead. Found
 *   for real on a Compose tab control where the visible label ("PASSWORD")
 *   sat on a non-clickable TextView and neither it nor its non-clickable
 *   sibling Button was what actually handled the tap -- a clickable
 *   wrapper View one level up (with no label/id of its own, so invisible
 *   to the snapshot otherwise) was. Tapping the label "succeeded"
 *   (WebDriver's click() doesn't error) but silently did nothing.
 *   semantic-act.js's toSelector() uses this, for "tap" actions only, to
 *   redirect to the element that actually responds.
 * @property {boolean} [secure] - Android's `password="true"`/iOS's
 *   SecureTextField role: this element's `text` is a masked placeholder
 *   (e.g. "•••••••"), not real content. Found for real on a live
 *   BrowserStack run: the password field's `label` is populated from
 *   that same masked text once something has been typed into it, and
 *   semantic-act.js's toSelector() was using `label` as a live
 *   WebDriver "text" selector -- which broke the instant the field was
 *   cleared and retyped (the dot-mask content changes), permanently
 *   losing the element and burning the rest of the loop's step budget
 *   on a selector that could never match again. toSelector() checks
 *   this flag to skip the live-text strategy for secure fields and use
 *   the stable xpath/resource-id instead.
 */

const ANDROID_BOUNDS_RE = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;

/**
 * Parses either platform's bounds shape into one consistent
 * {x, y, width, height} object, or undefined if neither was present.
 */
function parseBounds(node) {
  const androidBounds = node.getAttribute("bounds");
  if (androidBounds) {
    const match = ANDROID_BOUNDS_RE.exec(androidBounds);
    if (match) {
      const [, x1, y1, x2, y2] = match.map(Number);
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
  }

  const x = node.getAttribute("x");
  const y = node.getAttribute("y");
  const width = node.getAttribute("width");
  const height = node.getAttribute("height");
  if (x && y && width && height) {
    return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
  }

  return undefined;
}

// Editable-input roles across both platforms. Found from a real device
// run (MyYes app): a Compose-rendered text field is commonly left with
// NO resource-id/content-desc/text of its own -- only a separate
// sibling TextView carries the human-readable label ("Yes Number").
// Without this, buildGroundedSnapshot() would drop the actual input
// field entirely and the model would be left to (wrongly) target the
// label text instead, which then fails at execution time with a
// WebDriver "cannot set value" error since a label isn't editable.
// These roles are therefore included even when blank -- see the
// `nearbyLabel` heuristic below for how the model still gets a hint of
// which field it is.
const INPUT_ROLE_RE = /EditText|TextField|SecureTextField|SearchField/i;

/**
 * Computes a structural xpath for a node, identical in shape to
 * capture/recorder.js's buildXPath() (kept as a separate copy rather
 * than a shared import -- this module stays independent of the guided
 * path's capture layer by design, see this file's header). Used only
 * as a last-resort selector for a blank input field that has no
 * resource-id/accessibility-id/label of its own.
 */
function buildXPath(element) {
  const segments = [];
  let node = element;
  while (node && node.nodeType === 1 && node.tagName) {
    const tagName = node.tagName;
    let position = 1;
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && sibling.tagName === tagName) position += 1;
      sibling = sibling.previousSibling;
    }
    segments.unshift(`${tagName}[${position}]`);
    node = node.parentNode;
  }
  return "/" + segments.join("/");
}

/**
 * True for an iOS (XCUITest) tag name -- iOS's getPageSource() dump
 * tags every node `XCUIElementType<Kind>` (`XCUIElementTypeTextField`,
 * `XCUIElementTypeButton`, ...), where Android's uses either a
 * `android.widget.<Kind>`/`android.view.<Kind>` or a bare Compose
 * `View`/`ComposeView` -- never the `XCUIElementType` prefix.
 */
function isIosRole(tagName) {
  return typeof tagName === "string" && tagName.startsWith("XCUIElementType");
}

/**
 * Builds a WebDriverAgent "class chain" locator for an iOS element that
 * has no resource-id/accessibility-id/label of its own -- see the
 * `iosTagOccurrenceCounts` comment above for why this replaces
 * buildXPath() on iOS rather than just reusing it. `**` means "anywhere
 * in the tree" (no ancestor path to go stale), and the trailing
 * `[N]` is this element's 1-based occurrence index among same-tag
 * elements in document order, computed during the walk and stashed on
 * the node as `__iosClassChainIndex`.
 */
function buildIosClassChain(element) {
  return `**/${element.tagName}[${element.__iosClassChainIndex || 1}]`;
}

/**
 * Builds a WebDriverAgent "class chain" locator with an explicit
 * predicate, for an iOS element whose accessibility id is NOT unique on
 * screen -- found for real on a live BrowserStack run: this app's home
 * screen has a "LOGIN" button that opens the login form, and the form's
 * own submit button is ALSO named "LOGIN" (both report
 * `accessibilityId: "LOGIN"`). `$("~LOGIN")`/`findElement("accessibility
 * id", "LOGIN")` just returns whichever matches first -- here, that was
 * the SAME WebDriver element id both times (confirmed in a real run's
 * log), meaning the "submit" tap silently re-clicked the original
 * (now-hidden) home-screen button instead of the real, visible submit
 * button: both fields stayed correctly filled in, the tap "succeeded"
 * with no WebDriver error, and the screen simply never changed. Unlike
 * `buildIosClassChain()`'s plain occurrence-index (which only
 * disambiguates elements with NO name at all), this builds a
 * WebDriverAgent class-chain *predicate* -- documented, native syntax --
 * that matches on name AND visibility together, so it reliably picks
 * the one actually on screen right now rather than whichever instance
 * happens to come first in document order.
 */
function buildIosAmbiguousAccessibilityClassChain(element, name) {
  const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `**/${element.tagName}[\`name == "${escapedName}" AND visible == 1\`]`;
}

/**
 * Walks a captured accessibility tree and produces a flat, ref-indexed
 * list of every element that carries a usable label and/or identifier
 * -- the elements a semantic action could plausibly target -- plus any
 * blank editable input field (see INPUT_ROLE_RE above), since those are
 * legitimate "type into this" targets even with nothing to label them.
 * Purely structural containers with no label/id/input-role of their own
 * are walked (their children still appear) but not included as their
 * own entry; they add noise without adding anything an LLM could act on.
 *
 * @param {string} pageSourceXml
 * @returns {SnapshotElement[]}
 */
function buildGroundedSnapshot(pageSourceXml) {
  if (!pageSourceXml) return [];

  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } },
  }).parseFromString(pageSourceXml, "text/xml");

  const elements = [];
  let nextRef = 1;
  // The most recent non-blank label seen in document order -- a rough
  // but effective proxy for "the caption sitting next to this field",
  // since a label TextView is typically walked immediately before the
  // input it describes in both Android's and iOS's layout trees.
  let lastLabelSeen;
  // Found for real on a live BrowserStack iOS run: a structural xpath
  // built the same way as Android's (ancestor tag[position] chain, see
  // buildXPath below) was byte-for-byte reproducible across many
  // getPageSource() polls spanning 20+ seconds of a visibly UNCHANGED
  // screen, yet Appium's XCUITestDriver still returned "no such
  // element" for it every time ("doNativeFind" -- i.e. not a timing/
  // staleness issue, the native xpath engine just doesn't reliably
  // resolve a path built from the textual page-source dump the way
  // Android's UiAutomator2 driver does). WebDriverAgent's own "class
  // chain" locator (`**/XCUIElementTypeTextField[2]` -- the Nth element
  // of that type anywhere in the tree, in document order, no ancestor
  // path at all) is the natively-supported, documented alternative for
  // exactly this situation. Tracks, per iOS tag name, how many of that
  // tag have been seen so far in this same document-order walk, so any
  // iOS element that needs a last-resort positional selector can use
  // its 1-based occurrence index instead of an ancestor xpath.
  const iosTagOccurrenceCounts = new Map();

  const walk = (node, depth, nearestClickableAncestor) => {
    let clickableAncestorForChildren = nearestClickableAncestor;
    if (node.nodeType === 1 && node.getAttribute) {
      if (isIosRole(node.tagName)) {
        const count = (iosTagOccurrenceCounts.get(node.tagName) || 0) + 1;
        iosTagOccurrenceCounts.set(node.tagName, count);
        node.__iosClassChainIndex = count;
      }
      const text = node.getAttribute("text") || node.getAttribute("label") || node.getAttribute("value");
      const contentDesc = node.getAttribute("content-desc") || node.getAttribute("name");
      const resourceId = node.getAttribute("resource-id") || undefined; // Android only
      // Android only -- iOS trees don't carry this attribute, so
      // `clickable` stays undefined there and none of the ancestor-
      // redirect logic below ever fires (nothing to check it against).
      // xmldom's getAttribute() returns "" (not null) for a missing
      // attribute, per the DOM spec (hasAttribute is the existence
      // check) -- treat that the same as "not present" rather than as
      // clickable="false".
      const clickableAttr = node.getAttribute("clickable");
      const isClickable = !clickableAttr ? undefined : clickableAttr === "true";
      // Android signals a masked field via password="true". iOS carries
      // no such attribute -- it signals the same thing through the
      // element's own tag name (XCUIElementTypeSecureTextField) instead.
      // Originally only the Android attribute was checked here (the
      // comment used to say iOS "doesn't need it yet"); found for real
      // on a live BrowserStack iOS run (ios5) that it very much does:
      // without this, an iOS password field's masked display text
      // ("•••••••••") was treated as a normal label the same way bug 8
      // found on Android, toSelector() built a live `text`/predicate-
      // string selector from those dots, and the very next action
      // against that field failed with "element wasn't found" the
      // instant the mask's dot-count changed. Same bug, same fix,
      // second platform.
      const passwordAttr = node.getAttribute("password");
      const isSecure = passwordAttr === "true" || node.tagName === "XCUIElementTypeSecureTextField" || undefined;

      const label = (!isBlank(text) && clean(text)) || undefined;
      const accessibilityId = (!isBlank(contentDesc) && clean(contentDesc)) || undefined;
      const isBlankInput = !label && !accessibilityId && !resourceId && INPUT_ROLE_RE.test(node.tagName);
      // iOS has no resource-id to fall back on at all (always undefined
      // there), so a SecureTextField's positional locator can ONLY come
      // from this classChain/nearbyLabel computation -- but once a
      // password field has anything typed into it, its masked text
      // becomes its `label` (see the `isSecure` comment above), which
      // makes `isBlankInput` false and would otherwise skip computing
      // one entirely, at exactly the moment toSelector() most needs it
      // (the live-text/predicate-string strategy is the one being
      // avoided for secure fields in the first place). Android doesn't
      // need this: its secure fields always carry a resource-id
      // (unique, or ambiguous and handled by the post-pass below).
      const needsIosPositionalLocator = isSecure && isIosRole(node.tagName);

      if (label || accessibilityId || resourceId || isBlankInput) {
        elements.push({
          ref: nextRef++,
          role: node.tagName,
          label,
          resourceId,
          accessibilityId,
          depth,
          bounds: parseBounds(node),
          ...(isClickable !== undefined ? { clickable: isClickable } : {}),
          ...(isSecure ? { secure: true } : {}),
          ...((isBlankInput || needsIosPositionalLocator) && lastLabelSeen ? { nearbyLabel: lastLabelSeen } : {}),
          ...(isBlankInput || needsIosPositionalLocator
            ? isIosRole(node.tagName)
              ? { classChain: buildIosClassChain(node) }
              : { xpath: buildXPath(node) }
            : {}),
          // Kept only for the post-passes below, never part of the
          // returned SnapshotElement shape.
          __node: node,
          __nearbyLabelAtTime: lastLabelSeen,
          __nearestClickableAncestor: nearestClickableAncestor,
        });
      }

      if (label) lastLabelSeen = label;
      if (isClickable) clickableAncestorForChildren = node;
    }
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i += 1) walk(children[i], depth + 1, clickableAncestorForChildren);
  };
  walk(doc.documentElement, 0, undefined);

  // Found for real: a Compose tab control where the visible label
  // ("PASSWORD") sits on a non-clickable TextView, and the element that
  // actually handles the tap is a clickable ancestor View one or two
  // levels up -- neither the label nor the sibling Button (also
  // non-clickable here) is in the snapshot at all otherwise. Tapping the
  // label resolves and "succeeds" (WebDriver's click() doesn't error)
  // but visibly does nothing, silently wasting a step. For any element
  // that's explicitly non-clickable (clickable="false") but has a
  // clickable ancestor, record that ancestor's xpath so a tap on this
  // element can be redirected to the thing that actually responds.
  for (const el of elements) {
    if (el.clickable === false && el.__nearestClickableAncestor) {
      el.clickableAncestorXPath = buildXPath(el.__nearestClickableAncestor);
    }
  }

  // Found for real on a login screen where the Yes Number and Password
  // inputs are both plain EditTexts sharing the SAME resource-id
  // (my.yes.yes4g:id/edtCommon), distinguished only by their own label
  // TextView sitting next to them: a resource-id selector built from
  // either one is genuinely ambiguous on this screen (WebDriver's `$`
  // returns whichever matches first), so a "type the password"
  // instruction that resolves to this resource-id can silently act on
  // the Yes Number field instead. For any input-role element whose
  // resource-id isn't unique on this screen, attach the same
  // nearbyLabel/xpath fallback blank inputs already get, so toSelector()
  // (semantic-act.js) can prefer the disambiguating text/xpath over the
  // ambiguous resource-id.
  //
  // This used to additionally require `!el.label` before flagging an
  // element ambiguous, on the assumption that only a genuinely blank
  // input (no text of its own) could collide this way. Found for real,
  // reproduced 3/3 runs: an empty Android EditText's *hint* text (e.g.
  // "Yes Number", "Password") is exposed via the exact same `text`
  // attribute a filled-in value would use, so `el.label` was already
  // truthy for BOTH fields even before either had been typed into --
  // both got excluded from ambiguity detection, both fell through to
  // the plain (ambiguous) resource-id selector at toSelector()'s first
  // branch, and the second `type` step then resolved to the identical
  // `resource-id:edtCommon` selector step 1 had already used, tripping
  // engine/semantic-loop.js's anti-clobber veto and permanently failing
  // the loop before it ever reached LOGIN. A shared resource-id is
  // ambiguous to WebDriver's `$` regardless of whether the node also
  // happens to carry hint/placeholder text, so ambiguity here is judged
  // purely by resource-id uniqueness now; toSelector() still prefers
  // accessibility-id, then this element's own label/hint text (usually
  // unique per field even when the resource-id isn't), before falling
  // back to xpath.
  const resourceIdCounts = new Map();
  for (const el of elements) {
    if (el.resourceId) resourceIdCounts.set(el.resourceId, (resourceIdCounts.get(el.resourceId) || 0) + 1);
  }
  // Found for real on a live BrowserStack iOS run: a home screen's
  // "LOGIN" button (opens the login form) and the form's own submit
  // button can both report the exact same accessibility id -- unlike
  // the resource-id ambiguity above (Android input fields only),
  // nothing restricts this to input roles, so it's checked for every
  // element with an accessibility id, not just INPUT_ROLE_RE matches.
  // Confirmed in a real run's log: `$("~LOGIN")` returned the SAME
  // WebDriver element id both times it was used, so a later "submit"
  // tap silently re-clicked the original (by-then-hidden) button
  // instead of the real, visible one -- both fields stayed correctly
  // filled in, the tap reported success, and the screen just never
  // changed. See buildIosAmbiguousAccessibilityClassChain()'s own
  // comment for why a name+visibility predicate (not a plain occurrence
  // index) is what actually disambiguates this, and why it's iOS-only
  // (Android has no classChain fallback to offer here at all).
  const accessibilityIdCounts = new Map();
  for (const el of elements) {
    if (el.accessibilityId) accessibilityIdCounts.set(el.accessibilityId, (accessibilityIdCounts.get(el.accessibilityId) || 0) + 1);
  }
  for (const el of elements) {
    const isAmbiguousInput =
      el.resourceId &&
      resourceIdCounts.get(el.resourceId) > 1 &&
      INPUT_ROLE_RE.test(el.role);
    if (isAmbiguousInput) {
      el.ambiguousResourceId = true;
      if (el.__nearbyLabelAtTime) el.nearbyLabel = el.__nearbyLabelAtTime;
      el.xpath = buildXPath(el.__node);
    }
    if (el.accessibilityId && accessibilityIdCounts.get(el.accessibilityId) > 1 && isIosRole(el.role)) {
      el.ambiguousAccessibilityId = true;
      el.classChain = buildIosAmbiguousAccessibilityClassChain(el.__node, el.accessibilityId);
    }
    delete el.__node;
    delete el.__nearbyLabelAtTime;
    delete el.__nearestClickableAncestor;
  }

  return elements;
}

/**
 * Renders a snapshot as the compact indented text block an LLM reads,
 * e.g.:
 *   [1] Button "Log In" (id: login_button)
 *   [2] EditText "Username" (id: username_input)
 *   [3] StaticText "Welcome"
 *
 * Kept deliberately plain (no XML, no bounds/coordinates -- a semantic
 * action targets *what* to interact with, not *where*; engine/ and
 * capture/ already own coordinate-level concerns for the guided path).
 *
 * @param {SnapshotElement[]} elements
 * @returns {string}
 */
function snapshotToText(elements, options = {}) {
  return elements
    .map((el) => {
      const indent = "  ".repeat(el.depth);
      const quoted = el.label ? ` "${el.label}"` : "";
      const idParts = [];
      if (el.resourceId) idParts.push(`id: ${el.resourceId}`);
      if (el.accessibilityId && el.accessibilityId !== el.label) idParts.push(`a11y: ${el.accessibilityId}`);
      // See INPUT_ROLE_RE/nearbyLabel above -- a blank input field
      // still gets SOME identifying context in the rendered text, even
      // with no label of its own.
      if (el.nearbyLabel) idParts.push(`empty input near: "${el.nearbyLabel}"`);
      // Bounds are opt-in and left out of the default (guided-path-
      // adjacent) rendering to keep it compact -- a fused, screenshot-
      // accompanied resolution (buildFusedSnapshot()) turns this on so
      // a vision-capable model can relate a ref to a region of the image.
      if (options.includeBounds && el.bounds) {
        idParts.push(`at ${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height}`);
      }
      const idSuffix = idParts.length ? ` (${idParts.join(", ")})` : "";
      return `${indent}[${el.ref}] ${el.role}${quoted}${idSuffix}`;
    })
    .join("\n");
}

/**
 * Phase 2's "grounded screen snapshot: merge accessibility tree +
 * screenshot into one compact structured format an LLM reads directly"
 * bullet (docs/PHOENIX_SPEC.md §6) — the fusion itself is deliberately
 * simple: package the same ref-indexed element list (now carrying
 * bounds) alongside the raw screenshot bytes, rendered WITH bounds so a
 * multimodal model can relate "[3] Button "Log In" (at 100,560 880x100)"
 * to the matching region of the attached image. This does not draw
 * boxes on the image or crop it — that would need an image-processing
 * dependency this repo doesn't have yet — the model does the visual
 * correlation itself, the same way a person reading both the tree and
 * a screenshot side by side would.
 *
 * @param {string} pageSourceXml
 * @param {string} [screenshotBase64] - base64 PNG/JPEG data (no `data:`
 *   URI prefix), typically `await driver.takeScreenshot()`'s return
 *   value directly (WebdriverIO already returns base64, no prefix).
 * @returns {{elements: SnapshotElement[], text: string, screenshotBase64: string|undefined}}
 */
function buildFusedSnapshot(pageSourceXml, screenshotBase64) {
  const elements = buildGroundedSnapshot(pageSourceXml);
  return {
    elements,
    text: snapshotToText(elements, { includeBounds: true }),
    screenshotBase64: screenshotBase64 || undefined,
  };
}

/**
 * Looks up one element by its ref within a specific snapshot. Returns
 * undefined for an unknown ref (e.g. a stale ref from a previous
 * snapshot) -- callers must treat that as "couldn't resolve," not
 * guess at a fallback, per the same guided-then-autonomous caution
 * this whole layer is built around.
 *
 * @param {SnapshotElement[]} elements
 * @param {number} ref
 * @returns {SnapshotElement|undefined}
 */
function findByRef(elements, ref) {
  return elements.find((el) => el.ref === ref);
}

module.exports = { buildGroundedSnapshot, snapshotToText, findByRef, buildFusedSnapshot };
