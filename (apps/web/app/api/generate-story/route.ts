import { NextRequest, NextResponse } from "next/server";
import admin from "firebase-admin";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { OpenAI } from "openai";

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// Create a sliding-window rate limiter via Upstash Redis (Serverless-friendly)
const ratelimiter = new Ratelimit({
  redis: Redis.fromEnv(), // Expects UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env
  limiter: Ratelimit.slidingWindow(20, "1 m"), // Max 20 generations per minute per user
  analytics: true,
  prefix: "@toonora/ratelimit",
});

export async function POST(request: NextRequest) {
  try {
    // 1. Authentication Check: Extract and verify Firebase ID Token
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized: Missing token" }, { status: 401 });
    }
    
    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    // 2. Rate Limiting Check: Enforce quotas per authenticated User ID
    const { success, limit, reset, remaining } = await ratelimiter.limit(userId);
    
    const rateLimitHeaders = {
      "X-RateLimit-Limit": limit.toString(),
      "X-RateLimit-Remaining": remaining.toString(),
      "X-RateLimit-Reset": reset.toString(),
    };

    if (!success) {
      return NextResponse.json(
        { error: "Too many requests. Generation quota exceeded." }, 
        { status: 429, headers: rateLimitHeaders }
      );
    }

    // 3. Request Payload Validation
    const body = await request.json();
    const { projectId, prompt } = body;

    if (!projectId || !prompt) {
      return NextResponse.json({ error: "Missing required fields: projectId or prompt" }, { status: 400 });
    }

    // 4. Tenant Isolation / Authorization Check: Verify user owns the target project
    const projectRef = db.collection("projects").doc(projectId);
    const projectDoc = await projectRef.get();

    if (!projectDoc.exists) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (projectDoc.data()?.userId !== userId) {
      return NextResponse.json({ error: "Forbidden: You do not own this project" }, { status: 403 });
    }

    // 5. Secure AI Provider Execution (Behind service layer)
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are Toonora AI's creative assistant. Transform concepts into rich stories, scenes, and visual directions." },
        { role: "user", content: prompt }
      ],
    });

    const generatedContent = aiResponse.choices[0].message.content;

    // 6. Project History & Analytics Persistence
    const generationRef = projectRef.collection("generations").doc();
    await generationRef.set({
      id: generationRef.id,
      prompt,
      result: generatedContent,
      provider: "openai",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 7. Structured Server-Side Audit Log Entry
    await db.collection("auditLogs").add({
      userId,
      projectId,
      action: "STORY_GENERATION",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ 
      success: true, 
      data: generatedContent 
    }, { 
      status: 200, 
      headers: rateLimitHeaders 
    });

  } catch (error: any) {
    console.error("Secure API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
