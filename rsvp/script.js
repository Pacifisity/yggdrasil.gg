const form = document.getElementById("rsvp-form");
const textInput = document.getElementById("source-text");
const playBtn = document.getElementById("play-btn");
const wpmInput = document.getElementById("wpm-input");
const wordDisplay = document.getElementById("word-display");
const readerPanel = document.querySelector(".reader-panel");
const restartBtn = document.getElementById("restart-btn");
const lofiBtn = document.getElementById("lofi-btn");
const lofiIframe = document.getElementById("lofi-iframe");
const lofiMuteLine = document.getElementById("lofi-mute-line");

const LOFI_SRC = "https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1&controls=0&loop=1&modestbranding=1&playsinline=1";
let lofiPlaying = false;

lofiBtn.addEventListener("click", () => {
  if (!lofiPlaying) {
    lofiIframe.src = LOFI_SRC;
    lofiBtn.classList.add("is-playing");
    lofiBtn.setAttribute("aria-label", "Stop music");
    lofiMuteLine.setAttribute("display", "none");
  } else {
    lofiIframe.src = "about:blank";
    lofiBtn.classList.remove("is-playing");
    lofiBtn.setAttribute("aria-label", "Play music");
    lofiMuteLine.removeAttribute("display");
  }
  lofiPlaying = !lofiPlaying;
});

const placeholderText = "Paste text here...";
const DEFAULT_WPM = 500;
const PARAGRAPH_BREAK = "\x00PARA\x00";

let words = [];
let sourceWords = [];
let currentIndex = 0;
let timerId = null;
let paused = false;

function detachTextInput() {
  if (!textInput.isConnected) return;
  textInput.blur();
  textInput.remove();
}

function attachTextInput() {
  if (textInput.isConnected) return;
  wordDisplay.before(textInput);
}

function insertPlainTextAtCursor(text) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    textInput.textContent += text;
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const textNode = document.createTextNode(text);
  range.insertNode(textNode);

  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function tokenize(text) {
  const paragraphs = text.trim().split(/\n[\t ]*\n+/);
  const tokens = [];

  paragraphs.forEach((para, paraIndex) => {
    para.trim().split(/\s+/).filter(Boolean).forEach((word) => {
      // Split long hyphenated compound words so each part gets its own ORP
      if (word.includes("-") && word.replace(/[^A-Za-z]/g, "").length > 8) {
        const parts = word.split("-");
        parts.forEach((part, i) => {
          if (part) tokens.push(i < parts.length - 1 ? part + "-" : part);
        });
      } else {
        tokens.push(word);
      }
    });

    if (paraIndex < paragraphs.length - 1) {
      tokens.push(PARAGRAPH_BREAK);
    }
  });

  return tokens;
}

function getCoreLetterIndices(word) {
  const indices = [];
  for (let i = 0; i < word.length; i += 1) {
    if (/[A-Za-z0-9]/.test(word[i])) {
      indices.push(i);
    }
  }
  return indices;
}

function getFocalIndex(word) {
  const coreIndices = getCoreLetterIndices(word);
  const length = coreIndices.length;

  if (length === 0) {
    return Math.max(0, Math.floor(word.length / 2) - 1);
  }

  let corePoint = 0;

  if (length <= 1) corePoint = 0;
  else if (length <= 5) corePoint = 1;
  else if (length <= 9) corePoint = 2;
  else if (length <= 13) corePoint = 3;
  else corePoint = 4;

  return coreIndices[Math.min(corePoint, coreIndices.length - 1)];
}

function renderWord(word) {
  const focalIndex = getFocalIndex(word);
  let focalSpan = null;

  // Reset transform so getBoundingClientRect gives unshifted positions
  wordDisplay.style.transform = "translate(0, -50%)";
  wordDisplay.innerHTML = "";

  word.split("").forEach((char, index) => {
    const span = document.createElement("span");
    span.className = "word-char";
    if (!/[A-Za-z0-9]/.test(char)) span.classList.add("punct");
    span.textContent = char;
    if (index === focalIndex) {
      span.classList.add("focal");
      focalSpan = span;
    }
    wordDisplay.appendChild(span);
  });

  // Measure exact pixel center of the focal character and shift so it lands on center
  const wordRect = wordDisplay.getBoundingClientRect();
  const spanRect = focalSpan.getBoundingClientRect();
  const spanCenter = spanRect.left - wordRect.left + spanRect.width / 2;
  wordDisplay.style.transform = `translate(-${spanCenter}px, -50%)`;
}

function baseDelayMs() {
  const typedWpm = Number(wpmInput.value.trim());
  const wpm = Number.isFinite(typedWpm) && typedWpm > 0 ? typedWpm : DEFAULT_WPM;
  return Math.round(60000 / wpm);
}

function getDelayForWord(word) {
  const base = baseDelayMs();

  // Strip surrounding punctuation to get the true alphanumeric length
  const bare = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  const len = bare.length || word.length;

  // Length-based multiplier — longer words need more processing time
  let mult;
  if (len <= 2)       mult = 0.85; // articles, "I", "or" — processed instantly
  else if (len <= 4)  mult = 0.95;
  else if (len <= 6)  mult = 1.0;
  else if (len <= 10) mult = 1.2;
  else if (len <= 14) mult = 1.5;
  else                mult = 1.8; // very long words

  // Numbers take longer to parse cognitively
  if (/^[\d][0-9,.$%]*$/.test(bare)) mult *= 1.25;

  // Punctuation-based pause added AFTER the word is shown
  // Hard stop — sentence ends; brain needs to wrap up the thought
  if (/[.!?]["'\u2019\u201d]?$/.test(word)) {
    mult *= 2.0;
  // Soft stop — clause boundary
  } else if (/[,;:]$/.test(word)) {
    mult *= 1.4;
  // Em dash or ellipsis — narrative pause
  } else if (/[—]$/.test(word) || word.endsWith("...") || word.endsWith("--")) {
    mult *= 1.6;
  }

  return Math.round(base * mult);
}

function stopPlayback() {
  if (timerId !== null) {
    window.clearTimeout(timerId);
    timerId = null;
  }
}

function getSourceWords() {
  const sourceText = textInput.textContent.replace(placeholderText, "").trim();
  return sourceText ? tokenize(sourceText) : [];
}

function finishPlayback() {
  stopPlayback();
  paused = false;
  playBtn.classList.remove("is-playing");
  playBtn.setAttribute("aria-label", "Play");
  readerPanel.classList.remove("reading");
  attachTextInput();
  wordDisplay.style.transform = "translate(0, -50%)";
  wordDisplay.textContent = "";
  currentIndex = 0;
}

function scheduleNext() {
  if (paused || currentIndex >= words.length) {
    if (currentIndex >= words.length) {
      finishPlayback();
    }
    return;
  }

  const currentWord = words[currentIndex];
  currentIndex += 1;

  // Paragraph break — blank display with a long breath pause
  if (currentWord === PARAGRAPH_BREAK) {
    wordDisplay.innerHTML = "";
    wordDisplay.style.transform = "translate(0, -50%)";
    timerId = window.setTimeout(scheduleNext, Math.round(baseDelayMs() * 2.8));
    return;
  }

  renderWord(currentWord);
  const delay = getDelayForWord(currentWord);
  timerId = window.setTimeout(scheduleNext, delay);
}

function startPlayback() {
  if (!words.length) return;
  stopPlayback();
  paused = false;
  detachTextInput();
  readerPanel.classList.add("reading");
  playBtn.classList.add("is-playing");
  playBtn.setAttribute("aria-label", "Pause");
  scheduleNext();
}

function restartPlayback() {
  finishPlayback();
}

restartBtn.addEventListener("click", restartPlayback);

form.addEventListener("submit", (event) => {
  event.preventDefault();

  if (words.length && currentIndex < words.length && !paused && timerId !== null) {
    paused = true;
    stopPlayback();
    playBtn.classList.remove("is-playing");
    playBtn.setAttribute("aria-label", "Play");
    return;
  }

  if (words.length && paused && currentIndex < words.length) {
    paused = false;
    playBtn.classList.add("is-playing");
    playBtn.setAttribute("aria-label", "Pause");
    scheduleNext();
    return;
  }

  sourceWords = getSourceWords();
  words = [...sourceWords];
  currentIndex = 0;

  if (!words.length) {
    sourceWords = [];
    readerPanel.classList.remove("reading");
    attachTextInput();
    wordDisplay.textContent = "";
    playBtn.classList.remove("is-playing");
    playBtn.setAttribute("aria-label", "Play");
    return;
  }

  startPlayback();
});

window.addEventListener("resize", () => {
  // No cached measurements — each word re-measures live, nothing to clear
});

textInput.addEventListener("focus", () => {
  if (textInput.textContent.trim() === placeholderText) {
    textInput.textContent = "";
  }
});

textInput.addEventListener("blur", () => {
  if (!textInput.textContent.trim()) {
    textInput.textContent = placeholderText;
  }
});

textInput.addEventListener("paste", (event) => {
  event.preventDefault();
  const plainText = event.clipboardData?.getData("text/plain") || "";
  insertPlainTextAtCursor(plainText);
});
