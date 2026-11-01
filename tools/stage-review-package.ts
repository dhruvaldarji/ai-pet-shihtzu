const ID='louis-motion-preview';
export function previewInstaller(script:string){
  if(!/^louis_target="\$louis_(?:pets\/louis|root\/pets\/louis)"$/m.test(script))throw new Error("Official installer target changed; review its preview adaptation");
  return script.replace(/\blouis\b/g,ID).replace(/\bLouis\b/g,"Louis Motion Preview");
}

