# Operations & Run Guide: Twelve70 Styling Recommender

This document provides step-by-step instructions on how to start, manage, and verify each layer of the Twelve70 Outfit Builder stack:
1. **The Database Layer** (Docker Compose)
2. **The Backend Server Layer** (Node.js & Express)
3. **The Machine Learning Layer** (Python Virtual Environment & ONNX Pipeline)

---

## 1. The Database Layer (Docker)

Our MySQL database and phpMyAdmin admin console run inside isolated Docker containers.

### How to Start the Database
From the project root directory, run:
```bash
docker compose up -d
```
- **MySQL Database**: Active on port `3307` (to avoid conflicts with local MySQL).
- **phpMyAdmin**: Active on port `8081`. You can access it in your browser at `http://localhost:8081` (Username: `myuser`, Password: `mypass`).

### How to Stop the Database
To stop the containers and free up local system memory:
```bash
docker compose down
```

---

## 2. The Backend Server Layer (Node.js / Express)

Our backend server initializes the CSV matching indexes, connects to MySQL, loads the ONNX machine learning ranking session, and serves the static frontend HTML builders.

### Prerequisites
Make sure your local Node dependencies are installed:
```bash
npm install
```

### How to Start the Server
To start the local development server on port `3000` with hot-reloading:
```bash
npm run dev
```
Once started, you can access the interactive builders in your browser:
- **Sequential Builder**: `http://localhost:3000/outfit-builder.html`
- **Any-Sequence Builder**: `http://localhost:3000/any-sequence-builder.html`
- **DB Explorer**: `http://localhost:3000/db-explorer.html`

### How to Compile for Production
To check type safety and compile TypeScript files to Javascript:
```bash
npx tsc --noEmit     # Compiles without outputting files to check type safety
npm run build        # Compiles typescript into the /dist folder
```

---

## 3. The Machine Learning Layer (Python Venv)

Our Machine Learning pipeline is isolated inside a **Python Virtual Environment (`venv`)** in the project root to prevent conflicts with your Mac's global libraries.

### How to Activate the Virtual Environment
To work inside the virtual environment:
- **On Mac / Linux**:
  ```bash
  source venv/bin/activate
  ```
- **On Windows** (PowerShell):
  ```powershell
  .\venv\Scripts\Activate.ps1
  ```
*(To exit the virtual environment at any time, simply type `deactivate`).*

### How to Preprocess and Train the Model
1.  **Generate Positive & Negative Training Outfits**:
    Our negative sampling script randomly pairs outfits with incompatible color combinations to teach the Decision Tree model what constitutes a visual clash:
    ```bash
    ./venv/bin/python3 ml_pipeline/negative_sampling.py
    ```
2.  **Train the GBDT Model & Export to ONNX**:
    Our LambdaRank training script processes the dataset, fits LightGBM trees, and serializes the final model directly into the Node.js assets folder:
    ```bash
    ./venv/bin/python3 ml_pipeline/train.py
    ```
3.  **Upload Predicted Data to MySQL**:
    To upload all generated predictions directly to your database for easy viewing inside phpMyAdmin or the DB Explorer, run:
    ```bash
    npm run upload-predictions
    ```
