import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react';

export function Presence({children}:{children:ReactElement<Record<string,unknown>>|null|false}) {
  const last=useRef(children),[mounted,setMounted]=useState(!!children);
  if(children)last.current=children;
  const visible=!!children;
  useEffect(()=>{
    if(visible){setMounted(true);return;}
    const timer=setTimeout(()=>setMounted(false),matchMedia('(prefers-reduced-motion: reduce)').matches?0:180);
    return()=>clearTimeout(timer);
  },[visible]);
  const child=children||(mounted?last.current:null);
  return child?cloneElement(child,{'data-presence':visible?'enter':'exit',...(!visible?{inert:true,'aria-hidden':true}:{})}):null;
}

export function usePageMotion(nav:string) {
  useEffect(()=>{
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const node=document.querySelector('.ped-paper-body');
    const animation=node?.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:280,easing:'cubic-bezier(0.22, 1, 0.36, 1)'});
    return()=>animation?.cancel();
  },[nav]);
  useEffect(()=>{
    const active=new Map<HTMLDetailsElement,{animation:Animation;open:boolean}>();
    const click=(e:MouseEvent)=>{
      const summary=(e.target as Element)?.closest('summary'), details=summary?.parentElement;
      if(!(details instanceof HTMLDetailsElement)||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      e.preventDefault();const target=!(active.get(details)?.open??details.open);
      const start=details.getBoundingClientRect().height;
      if(details.classList.contains('chart-display-menu')){
        active.get(details)?.animation.cancel();details.open=true;
        const panel=details.querySelector<HTMLElement>('.chart-options');if(!panel){details.open=target;return;}
        panel.inert=!target;
        const frames=target?[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}]:[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(8px)'}];
        const animation=panel.animate(frames,{duration:210,easing:'cubic-bezier(0.22, 1, 0.36, 1)'});active.set(details,{animation,open:target});
        animation.onfinish=()=>{details.open=target;panel.inert=false;active.delete(details);};return;
      }
      active.get(details)?.animation.cancel();details.style.overflow='hidden';details.open=true;
      const end=target?details.scrollHeight:summary!.getBoundingClientRect().height+parseFloat(getComputedStyle(details).paddingTop)+parseFloat(getComputedStyle(details).paddingBottom);
      const animation=details.animate([{height:start+'px'},{height:end+'px'}],{duration:210,easing:'cubic-bezier(0.22, 1, 0.36, 1)'});
      active.set(details,{animation,open:target});
      animation.onfinish=()=>{details.open=target;details.style.overflow='';active.delete(details);};
    };
    document.addEventListener('click',click);
    return()=>{document.removeEventListener('click',click);active.forEach(({animation},node)=>{animation.cancel();node.style.overflow='';const panel=node.querySelector<HTMLElement>('.chart-options');if(panel)panel.inert=false;});};
  },[]);
}
