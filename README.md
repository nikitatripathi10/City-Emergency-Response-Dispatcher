# 🚨 City Emergency Response System (CERS)

A real-time emergency reporting and dispatch platform that connects citizens, control-room operators, and response teams on a single live system. Built with Firebase for instant data sync across role-based portals.

---

## 📌 Overview

During an emergency, delays in reporting and coordination cost time. CERS lets citizens report incidents in seconds, shows those incidents live on a map, and lets dispatchers assign the right response team immediately. Everyone sees updates in real time, with no manual refresh.

## ✨ Features

- **Real-time incident reporting:** reports appear instantly for responders
- **Role-based portals:** separate dashboards for each user role (e.g., Citizen, Dispatcher/Admin, Response Team)
- **Map integration:** view incident locations on an interactive map
- **Team dispatch:** assign and track response teams for each incident
- **Live status updates:** incident status syncs across all portals as it changes
- **Secure authentication:** login flow with role-based access

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML, CSS, JavaScript (ES Modules) |
| Backend / Database | Firebase *(Firestore / Realtime Database)* |
| Authentication | Firebase Authentication |
| Maps | *[Leaflet / Google Maps API: update as applicable]* |
| Hosting | *[Firebase Hosting / GitHub Pages: update as applicable]* |

## 👥 User Roles

| Role | What they can do |
|------|------------------|
| **Citizen** | Report emergencies, track the status of their reports |
| **Dispatcher / Admin** | View all incidents on the map, assign response teams, manage statuses |
| **Response Team** | Receive assignments, update progress on incidents |

## 🚀 Getting Started

### Prerequisites

- A modern web browser
- A [Firebase](https://firebase.google.com/) project
- Node.js *(only if your setup uses a local dev server)*

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/<your-username>/<your-repo-name>.git
   cd <your-repo-name>
   ```

2. **Set up Firebase**
   - Create a project in the [Firebase Console](https://console.firebase.google.com/)
   - Enable **Authentication** (Email/Password)
   - Create a **Firestore / Realtime Database**
   - Copy your web app config

3. **Add your Firebase config**

   Replace the placeholder values in your Firebase config file (e.g., `firebase-config.js`):
   ```javascript
   const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_PROJECT.firebaseapp.com",
     projectId: "YOUR_PROJECT_ID",
     storageBucket: "YOUR_PROJECT.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   ```

4. **Run the project**

   Because the project uses ES modules, serve it over HTTP instead of opening the file directly:
   ```bash
   npx serve .
   # or
   python -m http.server 8000
   ```
   Then open `http://localhost:8000` in your browser.

## 📁 Project Structure

```
├── index.html          # Landing / login page
├── css/                # Stylesheets
├── js/                 # App logic, Firebase config, auth, dispatch
├── pages/              # Role-based portals
└── README.md
```
*(Adjust to match your actual folder layout.)*

## 🔐 Security Note

Never commit real API keys or secrets to a public repo. Restrict your Firebase keys with security rules and authorized domains.

## 🔮 Future Improvements

- Push / SMS notifications for responders
- Analytics dashboard for incident trends
- Multi-language support
- Mobile app version

## 🤝 Contributing

Contributions, issues, and feature requests are welcome. Feel free to open an issue or submit a pull request.

## 📄 License

This project is licensed under the [MIT License](LICENSE).

## 👤 Author

**Nikita**
Student project: City Emergency Response System
