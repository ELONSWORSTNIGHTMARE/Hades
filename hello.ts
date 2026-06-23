console.log("Hello from @workspace/scripts");
export default function handler(req: any, res: any) {
  res.status(200).json({
    message: "Hello from Vercel!",
    status: "working",
    time: new Date().toISOString()
  });
}
