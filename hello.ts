export default function handler(req: any, res: any) {
  console.log("Hello from Vercel API");

  res.status(200).json({
    message: "Hello from Vercel!",
    status: "working",
    time: new Date().toISOString()
  });
}
