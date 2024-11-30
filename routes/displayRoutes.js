import express from "express"
import {getDisplayDetails } from "../controllers/displayController.js"

// Define a router for the display API
const displayRouter = express.Router();

displayRouter.get("/displays", async (req, res) => {
  try {
    const displayDetails = await getDisplayDetails();
    res.json({ success: true, data: displayDetails });
  } catch (error) {
    res.status(500).json({ success: false, message: error });
  }
});


export default displayRouter;