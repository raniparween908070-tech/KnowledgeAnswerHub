# Knowledge Answer Hub

Knowledge Answer Hub is a full-stack, mobile-responsive AI question-and-answer web application built with HTML5, CSS3, JavaScript, Node.js, Express.js, and the Google Gemini API (`@google/genai`).

## Features

- **AI Question & Answer Studio**: Ask any general knowledge or academic question and receive neatly formatted explanations with headings, paragraphs, and lists.
- **Multilingual Responses**: Supports English, Hindi, Urdu (with automatic RTL formatting), Spanish, Arabic (RTL), French, Bengali, German, Portuguese, and Japanese.
- **Subject Categories**: General Knowledge, Science, Technology, History, Education, Health, Business, Religion, and Other.
- **Follow-Up Questions**: Ask contextual follow-up questions directly below any answer.
- **One-Click Controls**: Copy answers, ask another question, clear conversation history, or click popular example questions.
- **Full Informational Pages**: Includes Home (`index.html`), About Us (`about.html`), Contact Us (`contact.html`), Privacy Policy (`privacy.html`), Disclaimer (`disclaimer.html`), and Terms & Conditions (`terms.html`).
- **Security Hardening**: Uses `helmet`, `express-rate-limit`, `dotenv`, strict input validation/sanitization, safe DOM rendering, and server-side storage of API credentials and contact messages.

## Project Structure

```text
knowledge-answer-hub/
├── package.json
├── server.js
├── .env.example
├── .gitignore
├── README.md
├── data/
└── public/
    ├── index.html
    ├── about.html
    ├── contact.html
    ├── privacy.html
    ├── disclaimer.html
    ├── terms.html
    ├── style.css
    ├── app.js
    ├── robots.txt
    └── sitemap.xml
```

## Getting a Gemini API Key (Google AI Studio)

1. Visit [Google AI Studio](https://aistudio.google.com/) and sign in with your Google account.
2. Open **Get API key** (or **Dashboard > API keys**).
3. Click **Create API key** and choose or create a Google Cloud project.
4. Copy the generated key and keep it private—never commit it to GitHub or place it in frontend files.

## Local Setup Instructions

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create your `.env` file**:
   Copy `.env.example` to a new file named `.env` in the project root:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and fill in your real values:
   ```env
   GEMINI_API_KEY=your_actual_gemini_api_key_here
   GEMINI_MODEL=gemini-3.1-flash-lite
   SITE_NAME=Knowledge Answer Hub
   CONTACT_EMAIL=your-email@example.com
   PORT=3000
   ```

3. **Run the website**:
   ```bash
   npm start
   ```
   Or for development:
   ```bash
   npm run dev
   ```

4. Open your browser at `http://localhost:3000`.

## Deploying Online (Node.js Hosting)

You can deploy Knowledge Answer Hub to any Node.js hosting provider such as Render, Railway, Fly.io, DigitalOcean App Platform, or a VPS with PM2/Nginx:

1. Push your repository to GitHub (`.gitignore` automatically excludes `.env`, `node_modules/`, and `data/`).
2. Create a new Web Service connected to your repository.
3. Set the **Build Command** to `npm install` (or `npm ci`) and the **Start Command** to `npm start`.
4. Configure the following **Environment Variables** in your hosting dashboard:
   - `GEMINI_API_KEY`: Your Google Gemini API key
   - `GEMINI_MODEL`: `gemini-3.1-flash-lite`
   - `SITE_NAME`: `Knowledge Answer Hub`
   - `CONTACT_EMAIL`: Your contact email address
   - `PORT`: Usually injected automatically by the host (defaults to `3000`)
5. Update `https://example.com` in `public/robots.txt`, `public/sitemap.xml`, and canonical `<link>` tags with your live domain.
