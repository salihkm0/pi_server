import express from "express"
import { getDisplayDetails } from "../controllers/displayController.js"

// Define a router for the display API
const displayRouter = express.Router();

displayRouter.get("/displays", async (req, res) => {
  try {
    const displayDetails = await getDisplayDetails();
    res.json({ 
      success: true, 
      count: displayDetails.length,
      displays: displayDetails 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Additional display management endpoints
displayRouter.post("/displays/:id/rotate", (req, res) => {
  // Implement display rotation if needed
  res.json({ 
    success: true, 
    message: "Display rotation not implemented" 
  });
});

displayRouter.get("/displays/primary", async (req, res) => {
  try {
    const displayDetails = await getDisplayDetails();
    const primaryDisplay = displayDetails.find(display => 
      display.status === "connected"
    ) || displayDetails[0];
    
    res.json({ 
      success: true, 
      display: primaryDisplay 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

export default displayRouter;