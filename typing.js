// typing.js
// Shared typing effect, used by the about, projects, skills and contact pages.
//
// HOW IT WORKS
//   Any heading that has the class "typing" is typed out letter by letter:
//       <h1 class="title typing">Your text</h1>
//   To turn the typing OFF for a heading, just delete the word "typing"
//   from its class. Nothing else needs to change.


// ---------- Setting (edit this) ----------

const TYPE_SPEED_MS = 35;   // pause between letters (smaller = faster)


// ---------- Start ----------

// This script sits in the <head>, so this line runs right away.
// While "is-typing" is on the page, each page's css keeps the content
// below the headings hidden, so it can appear after the typing.
document.documentElement.classList.add("is-typing");

// When the page is ready, type every heading marked with class "typing".
document.addEventListener("DOMContentLoaded", startTyping);

async function startTyping() {
  const headings = document.querySelectorAll(".typing");

  try {
    for (const heading of headings) {
      await typeText(heading);
    }
  } finally {
    // Always show the rest of the page, even if there was nothing to type.
    document.documentElement.classList.remove("is-typing");
  }
}


// ---------- Type one heading ----------

function typeText(heading) {
  return new Promise(function (resolve) {
    const fullText = heading.textContent.trim();
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Screen readers read the full text, not the half-typed one.
    heading.setAttribute("aria-label", fullText);

    // Swap the plain text for: [the letters typed so far] [the blinking cursor]
    const typed = document.createElement("span");
    const caret = document.createElement("span");
    typed.setAttribute("aria-hidden", "true");
    caret.setAttribute("aria-hidden", "true");
    caret.className = "caret";
    heading.textContent = "";
    heading.append(typed, caret);

    function finish() {
      heading.classList.remove("is-typing-now");
      heading.classList.add("is-done");
      setTimeout(resolve, 350);   // short pause before the next heading
    }

    // People who prefer less motion get the full text straight away.
    if (reduceMotion) {
      typed.textContent = fullText;
      finish();
      return;
    }

    heading.classList.add("is-typing-now");
    let letters = 0;

    const timer = setInterval(function () {
      letters = letters + 1;
      typed.textContent = fullText.slice(0, letters);

      if (letters >= fullText.length) {
        clearInterval(timer);
        finish();
      }
    }, TYPE_SPEED_MS);
  });
}
