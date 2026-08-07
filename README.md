<h1>🎬 avchub-studio - Your AI Video Production Control Plane</h1>

<p align="center">
  <a href="https://github.com/Adhilg8814/avchub-studio/releases" style="display:inline-block;padding:15px 30px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;border-radius:8px;font-size:20px;font-weight:bold;box-shadow:0 4px 15px rgba(102,126,234,0.4);">📥 Download avchub-studio</a>
</p>

## 🚀 What Is avchub-studio?

avchub-studio is a powerful yet easy-to-use application that helps you create professional AI-generated videos right from your own computer. Think of it as your personal video production control room. It handles all the complex tasks behind the scenes so you can focus on making great content.

Whether you need to generate voiceovers from text, align subtitles with audio, or assemble video clips into a final product, avchub-studio makes it simple. Best of all, it runs on your own machine, giving you complete control and privacy.

## ✨ Key Features

| Feature | What It Does |
|---------|--------------|
| **Text-to-Speech Narration** | Turn written scripts into natural-sounding voiceovers using various AI providers |
| **Subtitle Alignment** | Automatically sync subtitles with your video and audio tracks |
| **FFmpeg Video Assembly** | Combine video clips, audio, and subtitles into a polished final video |
| **Job Ledger System** | Keep track of every video project with guaranteed processing (exactly-once) |
| **Remote Worker Support** | Connect other computers to help process videos faster |
| **Pluggable Providers** | Use your preferred AI services for TTS and other features |

## 🖥️ System Requirements

avchub-studio is designed to run on Windows computers. To ensure smooth operation, your system should meet these minimum requirements:

- **Operating System:** Windows 10 or Windows 11 (64-bit)
- **Processor:** Intel Core i5 or AMD equivalent (2.0 GHz or faster)
- **Memory:** 8 GB RAM (16 GB recommended)
- **Storage:** 500 MB free space for the application (additional space for video projects)
- **Database:** PostgreSQL (the installer will guide you through setup)
- **Internet Connection:** Required for initial setup and optional AI services

## 📥 Download & Install

To get started with avchub-studio, follow these simple steps:

1. **Visit the download page:** Click the large button at the top of this page or go to: [https://github.com/Adhilg8814/avchub-studio/releases](https://github.com/Adhilg8814/avchub-studio/releases)

2. **Download the latest version:** On the releases page, find the most recent release (look for "Latest" tag). Download the file named `avchub-studio-windows.zip`.

3. **Extract the ZIP file:** Once downloaded, locate the file in your Downloads folder. Right-click on it and select "Extract All..." Choose a destination folder (like `C:\avchub-studio`) and click Extract.

4. **Run the application:** Open the folder where you extracted the files and double-click on `avchub-studio.exe`. A command window will open showing the application starting up.

5. **Access the web interface:** Open your web browser and go to `http://localhost:3000`. You should see the avchub-studio dashboard.

## 🔧 First-Time Setup

When you first run avchub-studio, you'll need to complete a quick setup:

1. **Create an admin account:** The setup wizard will ask you to create a username and password. This keeps your video projects secure.

2. **Configure database:** The application needs PostgreSQL to store project data. If you don't have PostgreSQL installed, the setup wizard provides easy instructions. You can also use the built-in SQLite option for testing.

3. **Connect AI providers (optional):** To use text-to-speech features, you can connect to services like Google Cloud TTS, Amazon Polly, or Azure Speech. The setup page will guide you through obtaining API keys.

## 🎬 Creating Your First Video

Once setup is complete, follow these steps to create a video:

1. **Start a new project:** Click the "New Project" button on the dashboard.

2. **Upload your video clips:** Drag and drop video files into the project workspace.

3. **Add a script:** Type or paste the narration text for your video. avchub-studio will convert this to speech.

4. **Generate subtitles:** Click "Generate Subtitles" to automatically create captions that match your narration.

5. **Assemble the video:** Review the preview, make adjustments, then click "Render Video." avchub-studio will combine everything into a final video file.

6. **Download your video:** Once rendering is complete, click the download button to save your video.

## 🛠️ Advanced Features

### Remote Workers
If you have multiple computers, you can set them up as "workers" to process videos faster. Each worker connects to your main avchub-studio installation and helps with rendering tasks.

### Job Ledger
Every action in avchub-studio is recorded in the job ledger. This ensures that if something goes wrong (like a power outage), no work is lost. The system guarantees that each job runs exactly once.

### Custom Providers
avchub-studio supports pluggable providers. You can add your own AI services or use community-developed providers for text-to-speech, video analysis, and more.

## ❓ Troubleshooting

**Application won't start:**
- Make sure you've extracted all files from the ZIP archive
- Check that PostgreSQL is running if you chose that database option
- Look at the command window for error messages

**Can't access web interface:**
- Ensure the application is still running in the command window
- Check that port 3000 is not being used by another program
- Try `http://127.0.0.1:3000` instead of `localhost`

**Video rendering fails:**
- Verify that FFmpeg is installed (the application includes it)
- Check that your video files are in a supported format (MP4, AVI, MOV)
- Ensure you have enough free disk space

## 📚 Getting Help

- **GitHub Issues:** Report bugs or request features at [https://github.com/Adhilg8814/avchub-studio/issues](https://github.com/Adhilg8814/avchub-studio/issues)
- **Documentation:** Check the `docs` folder in your installation directory for detailed guides
- **Community:** Join discussions on the project's GitHub Discussions page

## 🤝 Contributing

avchub-studio is open source and welcomes contributions. If you're a developer, you can help improve the code, add new features, or fix bugs. Visit the GitHub repository to learn how to get started.

## 📄 License

This project is open source. See the LICENSE file in the repository for details.

## Download

<p align="center">
  <a href="https://github.com/Adhilg8814/avchub-studio/releases" style="display:inline-block;padding:12px 25px;background:linear-gradient(135deg,#f093fb,#f5576c);color:#fff;text-decoration:none;border-radius:8px;font-size:18px;font-weight:bold;box-shadow:0 4px 15px rgba(245,87,108,0.4);">⬇️ Download avchub-studio</a>
</p>

Visit this link to download the application.